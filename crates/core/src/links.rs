//! Symbolic link and Windows junction inspection and editing.
//!
//! Listings report links via [`crate::FileEntry::is_symlink`] /
//! [`crate::FileEntry::is_junction`]; this module adds the details a file
//! manager needs on top of that: where a link points, whether that target is
//! still there, and how to repoint the link without losing it.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use uuid::Uuid;

/// The kind of link an entry is, which decides how it must be recreated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    /// Symbolic link created as a file link.
    SymlinkFile,
    /// Symbolic link created as a directory link.
    SymlinkDir,
    /// Windows junction (directory mount-point reparse point).
    Junction,
}

/// A link classification that costs nothing beyond the entry's own metadata.
///
/// Windows reports junctions as symlinks through [`std::fs::FileType`], so
/// telling them apart needs the reparse tag; that lookup only runs for the
/// rare entry that carries a reparse point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkClass {
    Symlink,
    Junction,
}

/// Details about a single link, resolved against its own directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkInfo {
    pub kind: LinkKind,
    /// Target exactly as stored in the link; may be relative.
    pub target: String,
    /// `target` resolved against the link's parent directory.
    pub resolved_target: String,
    /// True when `resolved_target` currently exists.
    pub target_exists: bool,
    /// True when `resolved_target` exists and is a directory.
    pub target_is_dir: bool,
}

fn not_a_link(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("{} is not a symbolic link or junction", path.display()),
    )
}

/// Read the reparse tag of an entry that carries a reparse point.
///
/// `FindFirstFileW` stashes the tag in `dwReserved0`, which is the cheapest
/// way to get it without opening a handle.
#[cfg(windows)]
fn reparse_tag(path: &Path) -> io::Result<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{FindClose, FindFirstFileW, WIN32_FIND_DATAW};

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
    let handle = unsafe { FindFirstFileW(wide.as_ptr(), &mut data) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    unsafe {
        FindClose(handle);
    }
    Ok(data.dwReserved0)
}

/// Classify an already-stat'd entry as a link without following it.
///
/// Returns `None` for entries that are not links, including reparse points
/// that are not symlinks or junctions (cloud placeholders, app exec links).
pub fn link_class(path: &Path, metadata: &fs::Metadata) -> Option<LinkClass> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
        const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C;

        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
            return None;
        }
        match reparse_tag(path) {
            Ok(IO_REPARSE_TAG_MOUNT_POINT) => Some(LinkClass::Junction),
            Ok(IO_REPARSE_TAG_SYMLINK) => Some(LinkClass::Symlink),
            Ok(_) => None,
            // Without the tag, fall back to what the file type claims rather
            // than dropping the link status entirely.
            Err(_) => metadata
                .file_type()
                .is_symlink()
                .then_some(LinkClass::Symlink),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        metadata
            .file_type()
            .is_symlink()
            .then_some(LinkClass::Symlink)
    }
}

/// Classify `path` as a symlink or junction, or fail if it is neither.
pub fn link_kind(path: &Path) -> io::Result<LinkKind> {
    let metadata = fs::symlink_metadata(path)?;
    let class = link_class(path, &metadata).ok_or_else(|| not_a_link(path))?;
    if class == LinkClass::Junction {
        return Ok(LinkKind::Junction);
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;

        Ok(
            if metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 {
                LinkKind::SymlinkDir
            } else {
                LinkKind::SymlinkFile
            },
        )
    }

    #[cfg(not(windows))]
    {
        // Unix symlinks carry no file/directory distinction of their own, so
        // report what the target currently is for display purposes.
        Ok(match fs::metadata(path) {
            Ok(target) if target.is_dir() => LinkKind::SymlinkDir,
            _ => LinkKind::SymlinkFile,
        })
    }
}

/// Resolve a link target lexically against the directory holding the link.
///
/// Lexical rather than [`fs::canonicalize`] so dangling links still resolve to
/// the path the user needs to see.
fn resolve_target(link_path: &Path, target: &Path) -> PathBuf {
    let joined = if target.is_absolute() {
        target.to_path_buf()
    } else {
        match link_path.parent() {
            Some(parent) => parent.join(target),
            None => target.to_path_buf(),
        }
    };

    let mut resolved = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !resolved.pop() {
                    resolved.push(Component::ParentDir);
                }
            }
            other => resolved.push(other),
        }
    }
    resolved
}

/// Read the target of a symlink or junction along with its current state.
pub fn read_link_info(path: &Path) -> io::Result<LinkInfo> {
    let kind = link_kind(path)?;
    let target = fs::read_link(path)?;
    let resolved = resolve_target(path, &target);
    let target_metadata = fs::metadata(&resolved).ok();

    Ok(LinkInfo {
        kind,
        target: target.to_string_lossy().into_owned(),
        resolved_target: resolved.to_string_lossy().into_owned(),
        target_exists: target_metadata.is_some(),
        target_is_dir: target_metadata.is_some_and(|metadata| metadata.is_dir()),
    })
}

fn create_link(kind: LinkKind, link_path: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        match kind {
            LinkKind::SymlinkFile => std::os::windows::fs::symlink_file(target, link_path),
            LinkKind::SymlinkDir => std::os::windows::fs::symlink_dir(target, link_path),
            LinkKind::Junction => create_junction(link_path, target),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = kind;
        std::os::unix::fs::symlink(target, link_path)
    }
}

fn remove_link(kind: LinkKind, link_path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        match kind {
            LinkKind::SymlinkFile => fs::remove_file(link_path),
            LinkKind::SymlinkDir | LinkKind::Junction => fs::remove_dir(link_path),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = kind;
        fs::remove_file(link_path)
    }
}

/// Repoint an existing symlink or junction at `new_target`.
///
/// The link kind is preserved: a junction stays a junction and a Windows
/// directory symlink stays a directory symlink. The old link is moved aside
/// first and restored if the new link cannot be created, so a failure never
/// leaves the user without their link.
///
/// # Errors
///
/// Fails if `link_path` is not a link, if `new_target` is empty, or if the
/// platform refuses to create the link (on Windows, creating a symlink
/// requires Developer Mode or elevation).
pub fn set_link_target(link_path: &Path, new_target: &str) -> io::Result<()> {
    let new_target = new_target.trim();
    if new_target.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Link target cannot be empty",
        ));
    }
    if new_target.chars().any(char::is_control) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Link target cannot contain control characters",
        ));
    }

    let kind = link_kind(link_path)?;
    let target = PathBuf::from(new_target);
    let parent = link_path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Cannot edit a link without a parent directory",
        )
    })?;

    if kind == LinkKind::Junction {
        // Junctions store an absolute local directory path; anything else
        // produces a link the OS cannot follow.
        if !target.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "A junction target must be an absolute path",
            ));
        }
        if !target.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "A junction target must be an existing directory",
            ));
        }
    }

    let backup = parent.join(format!(".explorie-link-{}", Uuid::new_v4()));
    fs::rename(link_path, &backup)?;

    match create_link(kind, link_path, &target) {
        Ok(()) => {
            // Losing the backup is not worth failing the edit for; the new
            // link is already in place.
            let _ = remove_link(kind, &backup);
            Ok(())
        }
        Err(error) => {
            fs::rename(&backup, link_path)?;
            Err(error)
        }
    }
}

/// Create a Windows junction at `link_path` pointing to `target`.
///
/// There is no std API for this, so the reparse point is written directly.
/// Unlike symlinks, junctions need no elevation.
#[cfg(windows)]
pub fn create_junction(link_path: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;

    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    // Tag + data length + reserved, ahead of the mount-point payload.
    const REPARSE_HEADER_LEN: usize = 8;
    // The four offset/length fields ahead of the path buffer.
    const MOUNT_POINT_HEADER_LEN: usize = 8;

    // The substitute name must be an NT-namespace path; the print name is what
    // tools such as `dir` display.
    let canonical = fs::canonicalize(target)?;
    let display = display_path(&canonical);
    let print_name: Vec<u16> = std::ffi::OsStr::new(&display).encode_wide().collect();
    let substitute_name: Vec<u16> = std::ffi::OsStr::new(&format!(r"\??\{display}"))
        .encode_wide()
        .collect();

    let path_buffer_len = (substitute_name.len() + 1 + print_name.len() + 1) * 2;
    let reparse_data_len = MOUNT_POINT_HEADER_LEN + path_buffer_len;
    let mut buffer = vec![0u8; REPARSE_HEADER_LEN + reparse_data_len];

    buffer[0..4].copy_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer[4..6].copy_from_slice(&(reparse_data_len as u16).to_le_bytes());
    // buffer[6..8] stays zero (Reserved).
    let substitute_offset: u16 = 0;
    let substitute_len = (substitute_name.len() * 2) as u16;
    let print_offset = substitute_len + 2;
    let print_len = (print_name.len() * 2) as u16;
    buffer[8..10].copy_from_slice(&substitute_offset.to_le_bytes());
    buffer[10..12].copy_from_slice(&substitute_len.to_le_bytes());
    buffer[12..14].copy_from_slice(&print_offset.to_le_bytes());
    buffer[14..16].copy_from_slice(&print_len.to_le_bytes());

    let path_buffer_start = REPARSE_HEADER_LEN + MOUNT_POINT_HEADER_LEN;
    let mut cursor = path_buffer_start;
    for unit in substitute_name.iter().chain(std::iter::once(&0)) {
        buffer[cursor..cursor + 2].copy_from_slice(&unit.to_le_bytes());
        cursor += 2;
    }
    for unit in print_name.iter().chain(std::iter::once(&0)) {
        buffer[cursor..cursor + 2].copy_from_slice(&unit.to_le_bytes());
        cursor += 2;
    }

    fs::create_dir(link_path)?;
    let result = (|| -> io::Result<()> {
        let directory = fs::OpenOptions::new()
            .write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(link_path)?;
        let mut returned = 0u32;
        let status = unsafe {
            DeviceIoControl(
                directory.as_raw_handle() as _,
                FSCTL_SET_REPARSE_POINT,
                buffer.as_ptr().cast(),
                buffer.len() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if status == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_dir(link_path);
    }
    result
}

/// Drop the `\\?\` verbatim prefix that `canonicalize` adds to drive paths.
///
/// Left alone for UNC paths, where the prefix is not purely cosmetic.
#[cfg(windows)]
fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => text.into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(not(windows))]
    use std::os::unix::fs::symlink;
    #[cfg(windows)]
    use std::os::windows::fs::{symlink_dir, symlink_file};

    /// Windows refuses symlink creation without Developer Mode or elevation;
    /// skip rather than fail on machines that have neither.
    #[cfg(windows)]
    fn make_file_link(target: &Path, link: &Path) -> bool {
        symlink_file(target, link).is_ok()
    }
    #[cfg(not(windows))]
    fn make_file_link(target: &Path, link: &Path) -> bool {
        symlink(target, link).is_ok()
    }

    #[cfg(windows)]
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        symlink_dir(target, link).is_ok()
    }
    #[cfg(not(windows))]
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        symlink(target, link).is_ok()
    }

    #[test]
    fn rejects_non_links() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("plain.txt");
        fs::write(&file, b"x").unwrap();

        let error = read_link_info(&file).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn reads_absolute_file_link() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("target.txt");
        fs::write(&target, b"hello").unwrap();
        let link = dir.path().join("link.txt");
        if !make_file_link(&target, &link) {
            return;
        }

        let info = read_link_info(&link).unwrap();
        assert_eq!(info.kind, LinkKind::SymlinkFile);
        assert!(info.target_exists);
        assert!(!info.target_is_dir);
        assert!(info.resolved_target.ends_with("target.txt"));
    }

    #[test]
    fn resolves_relative_target_against_link_directory() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("nested");
        fs::create_dir(&nested).unwrap();
        let target = dir.path().join("target.txt");
        fs::write(&target, b"hello").unwrap();
        let link = nested.join("link.txt");
        if !make_file_link(Path::new("../target.txt"), &link) {
            return;
        }

        let info = read_link_info(&link).unwrap();
        assert_eq!(info.resolved_target, target.to_string_lossy());
        assert!(info.target_exists);
    }

    #[test]
    fn reports_dangling_target() {
        let dir = tempdir().unwrap();
        let link = dir.path().join("dangling");
        if !make_file_link(&dir.path().join("missing.txt"), &link) {
            return;
        }

        let info = read_link_info(&link).unwrap();
        assert!(!info.target_exists);
        assert!(!info.target_is_dir);
    }

    #[test]
    fn edits_target_and_keeps_link_kind() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first.txt");
        let second = dir.path().join("second.txt");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        let link = dir.path().join("link.txt");
        if !make_file_link(&first, &link) {
            return;
        }

        set_link_target(&link, &second.to_string_lossy()).unwrap();

        let info = read_link_info(&link).unwrap();
        assert_eq!(info.kind, LinkKind::SymlinkFile);
        assert_eq!(info.resolved_target, second.to_string_lossy());
        assert_eq!(fs::read_to_string(&link).unwrap(), "second");
    }

    #[test]
    fn edits_directory_link_target() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        fs::write(second.join("inside.txt"), b"x").unwrap();
        let link = dir.path().join("link");
        if !make_dir_link(&first, &link) {
            return;
        }

        set_link_target(&link, &second.to_string_lossy()).unwrap();

        let info = read_link_info(&link).unwrap();
        assert_eq!(info.kind, LinkKind::SymlinkDir);
        assert!(info.target_is_dir);
        assert!(link.join("inside.txt").exists());
    }

    #[test]
    fn keeps_original_link_when_edit_is_rejected() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("target.txt");
        fs::write(&target, b"hello").unwrap();
        let link = dir.path().join("link.txt");
        if !make_file_link(&target, &link) {
            return;
        }

        assert!(set_link_target(&link, "   ").is_err());

        let info = read_link_info(&link).unwrap();
        assert_eq!(info.resolved_target, target.to_string_lossy());
    }

    #[test]
    fn rejects_editing_a_plain_file() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("plain.txt");
        fs::write(&file, b"x").unwrap();

        let error = set_link_target(&file, "elsewhere").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(file.is_file());
    }

    #[test]
    #[cfg(windows)]
    fn creates_and_edits_a_junction() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        fs::write(second.join("inside.txt"), b"x").unwrap();
        let link = dir.path().join("junction");
        create_junction(&link, &first).unwrap();

        let info = read_link_info(&link).unwrap();
        assert_eq!(info.kind, LinkKind::Junction);
        assert!(info.target_is_dir);

        set_link_target(&link, &second.to_string_lossy()).unwrap();

        let info = read_link_info(&link).unwrap();
        assert_eq!(info.kind, LinkKind::Junction);
        assert!(link.join("inside.txt").exists());
    }

    #[test]
    #[cfg(windows)]
    fn rejects_relative_junction_target() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("target");
        fs::create_dir(&target).unwrap();
        let link = dir.path().join("junction");
        create_junction(&link, &target).unwrap();

        let error = set_link_target(&link, "relative").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(read_link_info(&link).unwrap().kind, LinkKind::Junction);
    }
}
