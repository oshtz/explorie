use crate::listing::normalize_path;
use crate::{
    ActiveOperation, BlockingTask, ErrorCode, FileOperationEvent, FileOperationState,
    ServiceContext, ServiceError, ServiceEvent, ServiceResult, SharedState,
};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Typed requests for the small, user-initiated mutations that do not need a
/// long-running operation queue entry.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SafeMutationRequest {
    Rename {
        source_path: PathBuf,
        new_base_name: String,
    },
    CreateFolder {
        dir_path: PathBuf,
        base_name: String,
    },
    CreateNote {
        dir_path: PathBuf,
        base_name: String,
    },
    CreateWebsiteLink {
        dir_path: PathBuf,
        base_name: String,
        url: String,
    },
    DeletePermanently {
        path: PathBuf,
        recursive: bool,
    },
}

#[derive(Clone)]
pub struct MutationService {
    context: ServiceContext,
    shared: Arc<SharedState>,
}

impl MutationService {
    pub(crate) fn new(context: ServiceContext, shared: Arc<SharedState>) -> Self {
        Self { context, shared }
    }

    pub fn start_file_operation(
        &self,
        request: explorie_core::FileOperationRequest,
    ) -> ServiceResult<String> {
        if request
            .sources
            .iter()
            .any(|source| self.is_remote_root(source))
            || request
                .destination
                .as_deref()
                .is_some_and(|destination| self.is_remote_root(destination))
        {
            return Err(ServiceError::new(
                ErrorCode::RemoteUnavailable,
                "Refusing to mutate a managed remote-drive root",
            ));
        }

        let job_id = format!(
            "{}-{}",
            std::process::id(),
            self.shared.next_job_id.fetch_add(1, Ordering::Relaxed)
        );
        let cancelled = Arc::new(AtomicBool::new(false));
        self.shared
            .cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(job_id.clone(), Arc::clone(&cancelled));
        let guard = ActiveOperation::new(Arc::clone(&self.shared));
        let shared = Arc::clone(&self.shared);
        let events = self.context.events();
        let task_job_id = job_id.clone();
        std::thread::spawn(move || {
            let operation =
                explorie_core::perform_file_operation(request, &cancelled, |progress| {
                    events.publish(ServiceEvent::FileOperation(FileOperationEvent {
                        job_id: task_job_id.clone(),
                        state: FileOperationState::Running,
                        progress: Some(progress),
                        result: None,
                        error: None,
                    }));
                });

            let event = match operation {
                Ok(result) => FileOperationEvent {
                    job_id: task_job_id.clone(),
                    state: FileOperationState::Completed,
                    progress: None,
                    result: Some(result),
                    error: None,
                },
                Err(error) if error.kind() == io::ErrorKind::Interrupted => FileOperationEvent {
                    job_id: task_job_id.clone(),
                    state: FileOperationState::Cancelled,
                    progress: None,
                    result: None,
                    error: None,
                },
                Err(error) => FileOperationEvent {
                    job_id: task_job_id.clone(),
                    state: FileOperationState::Failed,
                    progress: None,
                    result: None,
                    error: Some(ServiceError::from(error)),
                },
            };
            remove_job(&shared, &task_job_id);
            events.publish(ServiceEvent::FileOperation(event));
            drop(guard);
        });

        Ok(job_id)
    }

    pub fn cancel_file_operation(&self, job_id: &str) -> bool {
        let cancellations = self
            .shared
            .cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cancelled) = cancellations.get(job_id) {
            cancelled.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }

    pub fn cancel_all(&self) {
        for cancelled in self
            .shared
            .cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
        {
            cancelled.store(true, Ordering::Relaxed);
        }
    }

    pub fn active_count(&self) -> u64 {
        self.shared.active_mutations.load(Ordering::Acquire)
    }

    /// Mark an exit attempt. The host should prevent exit and call
    /// [`cancel_all`](Self::cancel_all) while this returns `true`.
    pub fn request_exit(&self) -> bool {
        let active = self.active_count() > 0;
        self.shared.exit_requested.store(active, Ordering::Release);
        active
    }

    pub fn rename_path(&self, source_path: PathBuf, new_base_name: String) -> BlockingTask<String> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &source_path) {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to rename a managed remote-drive root",
                ));
            }
            let _guard = guard;
            rename_path_impl(&source_path, &new_base_name).map_err(ServiceError::from)
        })
    }

    pub fn create_folder(&self, dir_path: PathBuf, base_name: String) -> BlockingTask<String> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &dir_path) {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to mutate a managed remote-drive root",
                ));
            }
            let _guard = guard;
            create_folder_impl(&dir_path, &base_name).map_err(ServiceError::from)
        })
    }

    pub fn create_note(&self, dir_path: PathBuf, base_name: String) -> BlockingTask<String> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &dir_path) {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to mutate a managed remote-drive root",
                ));
            }
            let _guard = guard;
            create_note_impl(&dir_path, &base_name).map_err(ServiceError::from)
        })
    }

    pub fn create_website_link(
        &self,
        dir_path: PathBuf,
        base_name: String,
        url: String,
    ) -> BlockingTask<String> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &dir_path) {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to mutate a managed remote-drive root",
                ));
            }
            let _guard = guard;
            create_website_link_impl(&dir_path, &base_name, &url).map_err(ServiceError::from)
        })
    }

    pub fn delete_permanently(&self, path: PathBuf, recursive: bool) -> BlockingTask<()> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &path) {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to delete a managed remote-drive root",
                ));
            }
            let _guard = guard;
            delete_path_permanently_impl(&path, recursive).map_err(ServiceError::from)
        })
    }

    pub fn run_safe(&self, request: SafeMutationRequest) -> BlockingTask<String> {
        match request {
            SafeMutationRequest::Rename {
                source_path,
                new_base_name,
            } => self.rename_path(source_path, new_base_name),
            SafeMutationRequest::CreateFolder {
                dir_path,
                base_name,
            } => self.create_folder(dir_path, base_name),
            SafeMutationRequest::CreateNote {
                dir_path,
                base_name,
            } => self.create_note(dir_path, base_name),
            SafeMutationRequest::CreateWebsiteLink {
                dir_path,
                base_name,
                url,
            } => self.create_website_link(dir_path, base_name, url),
            SafeMutationRequest::DeletePermanently { path, recursive } => {
                let task = self.delete_permanently(path, recursive);
                self.context
                    .spawn_blocking(move || task.wait().map(|()| String::new()))
            }
        }
    }

    fn is_remote_root(&self, path: &Path) -> bool {
        remote_root(&self.shared, path)
    }
}

fn remote_root(shared: &SharedState, path: &Path) -> bool {
    shared
        .remote_roots
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(&normalize_path(path))
}

fn validate_file_name(name: &str) -> io::Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "File name cannot be empty",
        ));
    }
    if name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "File name cannot contain path separators or be . or ..",
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "File name cannot contain control characters",
        ));
    }
    #[cfg(windows)]
    {
        if name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.ends_with(['.', ' ']) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "File name is invalid on Windows",
            ));
        }
        let base = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || base
                .strip_prefix("COM")
                .or_else(|| base.strip_prefix("LPT"))
                .is_some_and(|number| {
                    matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                })
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "File name is reserved on Windows",
            ));
        }
    }
    Ok(name.to_string())
}

fn ensure_extension(name: &str, extension: &str) -> String {
    if name
        .to_ascii_lowercase()
        .ends_with(&extension.to_ascii_lowercase())
    {
        name.to_string()
    } else {
        format!("{name}{extension}")
    }
}

fn metadata_is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn validate_no_link_ancestors(path: &Path) -> io::Result<()> {
    let mut ancestors: Vec<&Path> = path.ancestors().collect();
    ancestors.reverse();
    for ancestor in ancestors {
        let metadata = fs::symlink_metadata(ancestor)?;
        if metadata_is_link(&metadata) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "Refusing to traverse a symbolic link or junction: {}",
                    ancestor.display()
                ),
            ));
        }
    }
    Ok(())
}

fn validate_real_directory(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Directory path must be absolute",
        ));
    }
    validate_no_link_ancestors(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata_is_link(&metadata) || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Destination must be a real directory",
        ));
    }
    Ok(())
}

fn mount_check_path(path: &Path, canonical: io::Result<PathBuf>) -> io::Result<PathBuf> {
    match canonical {
        Ok(path) => Ok(path),
        #[cfg(windows)]
        Err(error) if error.raw_os_error() == Some(1005) => Ok(path.to_path_buf()),
        Err(error) => Err(error),
    }
}

fn ensure_not_mount_root(path: &Path) -> io::Result<()> {
    let canonical = mount_check_path(path, fs::canonicalize(path))?;
    if canonical.parent().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Refusing to mutate a filesystem root",
        ));
    }
    let disks = sysinfo::Disks::new_with_refreshed_list();
    if disks.iter().any(|disk| {
        mount_check_path(disk.mount_point(), fs::canonicalize(disk.mount_point()))
            .is_ok_and(|mount| mount == canonical)
    }) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Refusing to mutate a mounted volume root",
        ));
    }
    Ok(())
}

fn suffixed_name(base_name: &str, number: u32, preserve_extension: bool) -> OsString {
    if number == 1 {
        return OsString::from(base_name);
    }
    if !preserve_extension {
        return OsString::from(format!("{base_name} ({number})"));
    }
    let path = Path::new(base_name);
    let stem = path.file_stem().unwrap_or(path.as_os_str());
    let mut name = OsString::from(stem);
    name.push(format!(" ({number})"));
    if let Some(extension) = path.extension() {
        name.push(".");
        name.push(extension);
    }
    name
}

fn create_unique_path(
    parent: &Path,
    base_name: &str,
    preserve_extension: bool,
    mut create: impl FnMut(&Path) -> io::Result<()>,
) -> io::Result<PathBuf> {
    for number in 1..=9_999 {
        let candidate = parent.join(suffixed_name(base_name, number, preserve_extension));
        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        match create(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "Could not find a unique file name",
    ))
}

fn write_new_text_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(contents)?;
        file.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

fn rename_path_impl(source: &Path, new_base_name: &str) -> io::Result<String> {
    if !source.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Source path must be absolute",
        ));
    }
    let metadata = fs::symlink_metadata(source)?;
    if !metadata_is_link(&metadata) {
        ensure_not_mount_root(source)?;
    }
    if !metadata_is_link(&metadata) && !metadata.is_file() && !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Unsupported filesystem entry",
        ));
    }
    let parent = source.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Cannot rename a filesystem root",
        )
    })?;
    validate_real_directory(parent)?;
    let name = validate_file_name(new_base_name)?;
    let destination = create_unique_path(parent, &name, true, |candidate| {
        explorie_core::rename_noreplace(source, candidate)
    })?;
    Ok(destination.to_string_lossy().into_owned())
}

fn create_folder_impl(directory: &Path, base_name: &str) -> io::Result<String> {
    validate_real_directory(directory)?;
    let name = validate_file_name(base_name)?;
    let path = create_unique_path(directory, &name, false, |candidate| {
        fs::create_dir(candidate)
    })?;
    Ok(path.to_string_lossy().into_owned())
}

fn create_note_impl(directory: &Path, base_name: &str) -> io::Result<String> {
    validate_real_directory(directory)?;
    let name = validate_file_name(&ensure_extension(base_name, ".md"))?;
    let path = create_unique_path(directory, &name, true, |candidate| {
        write_new_text_file(candidate, b"# New Note\n")
    })?;
    Ok(path.to_string_lossy().into_owned())
}

fn create_website_link_impl(directory: &Path, base_name: &str, url: &str) -> io::Result<String> {
    validate_real_directory(directory)?;
    let name = validate_file_name(&ensure_extension(base_name, ".url"))?;
    let url = url.trim();
    if url.chars().any(char::is_control) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Website URL cannot contain control characters",
        ));
    }
    let normalized = url.to_ascii_lowercase();
    if !normalized.starts_with("https://") && !normalized.starts_with("http://") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Website URL must use http or https",
        ));
    }
    let contents = format!("[InternetShortcut]\nURL={url}\n");
    let path = create_unique_path(directory, &name, true, |candidate| {
        write_new_text_file(candidate, contents.as_bytes())
    })?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeleteEntryKind {
    File,
    Directory,
    Link,
}

fn delete_entry_kind(metadata: &fs::Metadata) -> io::Result<DeleteEntryKind> {
    if metadata_is_link(metadata) {
        Ok(DeleteEntryKind::Link)
    } else if metadata.is_file() {
        Ok(DeleteEntryKind::File)
    } else if metadata.is_dir() {
        Ok(DeleteEntryKind::Directory)
    } else {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "special filesystem entries cannot be permanently deleted",
        ))
    }
}

#[cfg(unix)]
fn same_device(root: &fs::Metadata, candidate: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    root.dev() == candidate.dev()
}

#[cfg(not(unix))]
fn same_device(_root: &fs::Metadata, _candidate: &fs::Metadata) -> bool {
    true
}

fn collect_delete_entries(
    path: &Path,
    root_metadata: &fs::Metadata,
    entries: &mut Vec<(PathBuf, DeleteEntryKind)>,
) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    let kind = delete_entry_kind(&metadata)?;
    if kind != DeleteEntryKind::Link && !same_device(root_metadata, &metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "refusing to cross a mounted filesystem at {}",
                path.display()
            ),
        ));
    }
    entries.push((path.to_path_buf(), kind));
    if kind == DeleteEntryKind::Directory {
        for child in fs::read_dir(path)? {
            collect_delete_entries(&child?.path(), root_metadata, entries)?;
        }
    }
    Ok(())
}

fn remove_link(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(file_error) => fs::remove_dir(path).map_err(|_| file_error),
    }
}

fn remove_planned_entry(path: &Path, expected: DeleteEntryKind) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    let actual = delete_entry_kind(&metadata)?;
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "filesystem entry changed during deletion: {}",
                path.display()
            ),
        ));
    }
    match actual {
        DeleteEntryKind::File => fs::remove_file(path),
        DeleteEntryKind::Directory => fs::remove_dir(path),
        DeleteEntryKind::Link => remove_link(path),
    }
}

fn delete_path_permanently_impl(path: &Path, recursive: bool) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Delete path must be absolute",
        ));
    }
    if let Some(parent) = path.parent() {
        validate_no_link_ancestors(parent)?;
    }
    let root_metadata = fs::symlink_metadata(path)?;
    let root_kind = delete_entry_kind(&root_metadata)?;
    if root_kind != DeleteEntryKind::Link {
        ensure_not_mount_root(path)?;
    }
    if root_kind != DeleteEntryKind::Directory || !recursive {
        return remove_planned_entry(path, root_kind);
    }
    let mut entries = Vec::new();
    collect_delete_entries(path, &root_metadata, &mut entries)?;
    for (entry, kind) in entries.into_iter().rev() {
        remove_planned_entry(&entry, kind)?;
    }
    Ok(())
}

fn remove_job(shared: &SharedState, job_id: &str) {
    shared
        .cancellations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(job_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NativeServices, ResourcePaths};
    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temporary directory")
    }

    #[test]
    fn safe_mutations_never_overwrite_and_validate_urls() {
        let temp = temp_dir();
        let root = temp.path().to_path_buf();
        fs::write(root.join("report.txt"), "existing").unwrap();
        fs::write(root.join("draft.txt"), "draft").unwrap();
        let services = NativeServices::new(ResourcePaths::test(&root));

        let renamed = services
            .mutations
            .rename_path(root.join("draft.txt"), "report.txt".into())
            .wait()
            .unwrap();
        assert_eq!(Path::new(&renamed).file_name().unwrap(), "report (2).txt");
        assert_eq!(
            fs::read_to_string(root.join("report.txt")).unwrap(),
            "existing"
        );

        let note = services
            .mutations
            .create_note(root.clone(), "Meeting Notes".into())
            .wait()
            .unwrap();
        assert_eq!(fs::read_to_string(note).unwrap(), "# New Note\n");
        assert!(
            services
                .mutations
                .create_website_link(root, "unsafe".into(), "javascript:alert(1)".into())
                .wait()
                .is_err()
        );
    }

    #[test]
    fn exit_request_tracks_active_jobs_and_cancellation() {
        let root = temp_dir();
        let services = NativeServices::new(ResourcePaths::test(root.path()));
        let events = services.subscribe();
        let shared = Arc::clone(&services.mutations.shared);
        let guard = ActiveOperation::new(shared);
        assert_eq!(services.mutations.active_count(), 1);
        assert!(services.mutations.request_exit());
        services.mutations.cancel_all();
        drop(guard);
        assert_eq!(services.mutations.active_count(), 0);
        assert!(matches!(
            events
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap(),
            ServiceEvent::MutationIdle
        ));
    }

    #[cfg(unix)]
    #[test]
    fn permanent_delete_unlinks_links_without_following_them() {
        use std::os::unix::fs::symlink;
        let temp = temp_dir();
        let outside = temp.path().join("outside");
        let source = temp.path().join("source");
        fs::create_dir(&outside).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(outside.join("keep.txt"), "keep").unwrap();
        symlink(&outside, source.join("link")).unwrap();
        let services = NativeServices::new(ResourcePaths::test(temp.path()));
        services
            .mutations
            .delete_permanently(source, true)
            .wait()
            .unwrap();
        assert_eq!(
            fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "keep"
        );
    }
}
