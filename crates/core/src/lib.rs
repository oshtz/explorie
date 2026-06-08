//! # explorie Core
//!
//! Core library for the explorie file manager, providing file system operations
//! and metadata management.
//!
//! ## Features
//!
//! - **Directory Listing**: Fast, parallel directory listing with metadata
//! - **Folder Size Calculation**: Recursive directory size with caching
//! - **Custom Metadata**: Read/write `.explorie.json` files for custom fields
//! - **Archive Operations**: Create and extract ZIP/TAR archives
//! - **Platform Support**: Windows and macOS specific features (junctions, xattrs)
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use explorie_core::{list_dir, list_dir_with_sizes, dir_size};
//! use std::path::Path;
//!
//! // List directory contents
//! let entries = list_dir(Path::new("/path/to/dir")).unwrap();
//!
//! // List with folder sizes
//! let entries = list_dir_with_sizes(Path::new("/path/to/dir"), true).unwrap();
//!
//! // Get total size of a directory
//! let size = dir_size(Path::new("/path/to/dir")).unwrap();
//! ```
//!
//! ## Custom Fields
//!
//! Files can have custom metadata stored in `.explorie.json`:
//!
//! ```json
//! {
//!   "document.pdf": {
//!     "status": "Done",
//!     "priority": "High",
//!     "tags": ["work", "important"]
//!   }
//! }
//! ```
//!
//! Use [`update_custom_fields`] to modify custom fields programmatically.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::SystemTime;

use rayon::prelude::*;
use tracing::{debug, warn};
use uuid::Uuid;
use walkdir::WalkDir;

pub mod archive;
pub use archive::*;

/// Represents a file or directory entry in explorie.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub id: Uuid,
    pub path: PathBuf,
    pub size: u64,
    pub modified: SystemTime,
    pub hidden: bool,
    pub is_dir: bool,
    pub custom: HashMap<String, serde_json::Value>, // from .explorie.json
    /// True if this entry is a symbolic link
    #[serde(default)]
    pub is_symlink: bool,
    /// True if this is a Windows junction point or reparse point
    #[serde(default)]
    pub is_junction: bool,
    /// The target path if this is a symlink or junction
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
    /// True if file has extended attributes (macOS xattrs, Windows ADS)
    #[serde(default)]
    pub has_xattrs: bool,
}

const CUSTOM_FIELDS_CACHE_LIMIT: usize = 64;

struct CustomFieldsCacheEntry {
    modified: Option<SystemTime>,
    fields: HashMap<String, HashMap<String, serde_json::Value>>,
}

struct CustomFieldsCache {
    entries: HashMap<PathBuf, CustomFieldsCacheEntry>,
    order: VecDeque<PathBuf>,
}

static CUSTOM_FIELDS_CACHE: OnceLock<RwLock<CustomFieldsCache>> = OnceLock::new();

fn custom_fields_cache() -> &'static RwLock<CustomFieldsCache> {
    CUSTOM_FIELDS_CACHE.get_or_init(|| {
        RwLock::new(CustomFieldsCache {
            entries: HashMap::new(),
            order: VecDeque::new(),
        })
    })
}

/// Load custom fields from .explorie.json file in a directory
fn load_custom_fields(dir_path: &Path) -> HashMap<String, HashMap<String, serde_json::Value>> {
    let explorie_json_path = dir_path.join(".explorie.json");
    if !explorie_json_path.exists() {
        if let Ok(mut cache) = custom_fields_cache().write() {
            cache.entries.remove(&explorie_json_path);
            cache.order.retain(|path| path != &explorie_json_path);
        }
        return HashMap::new();
    }

    let modified = fs::metadata(&explorie_json_path)
        .ok()
        .and_then(|metadata| metadata.modified().ok());

    if let Ok(cache) = custom_fields_cache().read()
        && let Some(entry) = cache.entries.get(&explorie_json_path)
        && entry.modified == modified
    {
        return entry.fields.clone();
    }

    let parsed: HashMap<String, HashMap<String, serde_json::Value>> =
        match fs::read_to_string(&explorie_json_path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(json) => json,
                Err(e) => {
                    warn!(
                        path = ?explorie_json_path,
                        error = %e,
                        "Error parsing .explorie.json"
                    );
                    return HashMap::new();
                }
            },
            Err(e) => {
                debug!(
                    path = ?explorie_json_path,
                    error = %e,
                    "Could not read .explorie.json (may not exist)"
                );
                return HashMap::new();
            }
        };

    if let Ok(mut cache) = custom_fields_cache().write() {
        if cache.entries.len() >= CUSTOM_FIELDS_CACHE_LIMIT
            && let Some(oldest) = cache.order.pop_front()
        {
            cache.entries.remove(&oldest);
        }
        cache.order.retain(|path| path != &explorie_json_path);
        cache.order.push_back(explorie_json_path.clone());
        cache.entries.insert(
            explorie_json_path.clone(),
            CustomFieldsCacheEntry {
                modified,
                fields: parsed.clone(),
            },
        );
    }

    parsed
}

/// Check if a file has extended attributes (macOS xattrs, Windows ADS).
/// This is a best-effort check that returns false if unable to determine.
fn has_extended_attributes(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        // Use listxattr to check if there are any xattrs
        let c_path = match CString::new(path.as_os_str().as_bytes()) {
            Ok(p) => p,
            Err(_) => return false,
        };

        // listxattr returns the size of the buffer needed, or -1 on error
        // A size > 0 means there are extended attributes
        // XATTR_NOFOLLOW = 0x0001 - don't follow symlinks
        let size = unsafe {
            libc::listxattr(
                c_path.as_ptr(),
                std::ptr::null_mut(),
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        size > 0
    }

    #[cfg(windows)]
    {
        // On Windows, check for Alternate Data Streams by looking for ':'
        // in the path after the drive letter, or by attempting to enumerate streams.
        // For simplicity, we check if the file has the FILE_ATTRIBUTE_SPARSE_FILE
        // or has any named streams beyond the main $DATA stream.
        // A full implementation would use FindFirstStreamW/FindNextStreamW.

        use std::os::windows::fs::MetadataExt;

        // Check for sparse file attribute as a proxy (often used with ADS)
        if let Ok(meta) = path.symlink_metadata() {
            const FILE_ATTRIBUTE_SPARSE_FILE: u32 = 0x200;
            // This is a simplified check - true ADS detection requires Win32 API
            return (meta.file_attributes() & FILE_ATTRIBUTE_SPARSE_FILE) != 0;
        }
        false
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        // On Linux, use listxattr
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let c_path = match CString::new(path.as_os_str().as_bytes()) {
            Ok(p) => p,
            Err(_) => return false,
        };

        let size = unsafe { libc::llistxattr(c_path.as_ptr(), std::ptr::null_mut(), 0) };
        size > 0
    }
}

/// Calculate the total size of a directory or file in bytes.
///
/// For files, returns the file size. For directories, recursively calculates
/// the total size of all files within (excluding symlinks).
///
/// Uses parallel iteration via rayon for performance on large directories.
///
/// # Arguments
///
/// * `path` - Path to the file or directory
///
/// # Returns
///
/// Total size in bytes, or an IO error if the path cannot be read.
///
/// # Example
///
/// ```rust,no_run
/// use explorie_core::dir_size;
/// use std::path::Path;
///
/// let size = dir_size(Path::new("/home/user/Documents")).unwrap();
/// println!("Total size: {} bytes", size);
/// ```
pub fn dir_size(path: &Path) -> io::Result<u64> {
    if path.is_file() {
        return Ok(fs::metadata(path).map(|md| md.len()).unwrap_or(0));
    }

    let total = WalkDir::new(path)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let ft = entry.file_type();
            !ft.is_symlink() && ft.is_file()
        })
        .par_bridge()
        .map(|entry| entry.metadata().map(|md| md.len()).unwrap_or(0))
        .sum();

    Ok(total)
}

/// List all files and directories in the given path.
///
/// Returns a vector of [`FileEntry`] structs with metadata for each item.
/// Automatically loads custom fields from `.explorie.json` if present.
///
/// # Arguments
///
/// * `path` - Directory path to list
/// * `calc_dir_size` - If true, recursively calculate folder sizes (slower but more informative)
///
/// # Returns
///
/// Vector of file entries, or an IO error if the directory cannot be read.
///
/// # Features
///
/// - Parallel iteration for fast listing of large directories
/// - Detects symlinks and Windows junction points
/// - Checks for extended attributes (macOS xattrs)
/// - Loads custom metadata from `.explorie.json`
/// - Handles hidden files (dotfiles and Windows hidden attribute)
///
/// # Example
///
/// ```rust,no_run
/// use explorie_core::list_dir_with_sizes;
/// use std::path::Path;
///
/// // List without folder sizes (fast)
/// let entries = list_dir_with_sizes(Path::new("/path"), false).unwrap();
///
/// // List with folder sizes (slower, calculates sizes)
/// let entries = list_dir_with_sizes(Path::new("/path"), true).unwrap();
///
/// for entry in entries {
///     println!("{}: {} bytes", entry.path.display(), entry.size);
/// }
/// ```
pub fn list_dir_with_sizes(path: &Path, calc_dir_size: bool) -> io::Result<Vec<FileEntry>> {
    // Load custom fields from .explorie.json if it exists
    let custom_fields = load_custom_fields(path);
    let dir_entries: Vec<fs::DirEntry> = fs::read_dir(path)?.collect::<Result<_, _>>()?;

    let results: Vec<Option<FileEntry>> = dir_entries
        .into_par_iter()
        .map(|entry| -> io::Result<Option<FileEntry>> {
            let file_name = entry.file_name();
            let file_name_str = file_name.to_string_lossy();

            // Skip the .explorie.json file itself from listings
            if file_name_str == ".explorie.json" {
                return Ok(None);
            }

            // Get symlink metadata (doesn't follow links)
            let symlink_meta = entry.path().symlink_metadata()?;
            let is_symlink = symlink_meta.file_type().is_symlink();

            // Check for Windows junction points / reparse points
            #[cfg(windows)]
            let is_junction = {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
                (symlink_meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 && !is_symlink
            };
            #[cfg(not(windows))]
            let is_junction = false;

            // Get link target for symlinks and junctions
            let link_target = if is_symlink || is_junction {
                fs::read_link(entry.path())
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned())
            } else {
                None
            };

            // Check for extended attributes
            let has_xattrs = has_extended_attributes(&entry.path());

            // Get regular metadata (follows links)
            let metadata = entry.metadata()?;
            let file_type = metadata.file_type();
            let is_dir = file_type.is_dir();

            // Calculate size - don't follow symlinks/junctions for size calculation
            let size = if is_symlink || is_junction {
                // For links, just use the link's own size
                symlink_meta.len()
            } else if file_type.is_file() {
                metadata.len()
            } else if is_dir && calc_dir_size {
                // Compute recursive directory size; ignore errors by treating as 0
                dir_size(&entry.path()).unwrap_or(0)
            } else {
                0
            };
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);

            // Determine hidden status (platform-aware)
            #[cfg(windows)]
            let is_hidden_os = {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
                (metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN) != 0
            };
            #[cfg(not(windows))]
            let is_hidden_os = false;

            let name_is_dot_hidden =
                file_name_str.starts_with('.') && file_name_str != "." && file_name_str != "..";

            // Get custom fields for this entry if they exist
            let custom = if let Some(fields) = custom_fields.get(file_name_str.as_ref()) {
                fields.clone()
            } else {
                HashMap::new()
            };

            let path_buf = entry.path();
            let path_key = path_buf.to_string_lossy().replace('\\', "/");
            let entry_id = Uuid::new_v5(&Uuid::NAMESPACE_URL, path_key.as_bytes());

            Ok(Some(FileEntry {
                id: entry_id,
                path: path_buf,
                size,
                modified,
                hidden: is_hidden_os || name_is_dot_hidden,
                is_dir,
                custom,
                is_symlink,
                is_junction,
                link_target,
                has_xattrs,
            }))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(results.into_iter().flatten().collect())
}

/// List directory contents without calculating folder sizes.
///
/// This is a convenience wrapper around [`list_dir_with_sizes`] with
/// `calc_dir_size` set to false. Faster for large directories when
/// folder sizes aren't needed.
///
/// # Example
///
/// ```rust,no_run
/// use explorie_core::list_dir;
/// use std::path::Path;
///
/// let entries = list_dir(Path::new("/path/to/dir")).unwrap();
/// ```
pub fn list_dir(path: &Path) -> io::Result<Vec<FileEntry>> {
    list_dir_with_sizes(path, false)
}

/// Create or overwrite a `.explorie.json` file with custom field definitions.
///
/// This replaces the entire contents of the `.explorie.json` file. To update
/// individual file fields, use [`update_custom_fields`] instead.
///
/// # Arguments
///
/// * `dir_path` - Directory where `.explorie.json` will be created
/// * `fields` - Map of filename -> field map
///
/// # Example
///
/// ```rust,no_run
/// use explorie_core::create_explorie_schema;
/// use std::collections::HashMap;
/// use std::path::Path;
/// use serde_json::json;
///
/// let mut fields = HashMap::new();
/// let mut file_fields = HashMap::new();
/// file_fields.insert("status".to_string(), json!("Done"));
/// fields.insert("document.pdf".to_string(), file_fields);
///
/// create_explorie_schema(Path::new("/path/to/dir"), fields).unwrap();
/// ```
pub fn create_explorie_schema(
    dir_path: &Path,
    fields: HashMap<String, HashMap<String, serde_json::Value>>,
) -> io::Result<()> {
    let explorie_json_path = dir_path.join(".explorie.json");
    let json_content = serde_json::to_string_pretty(&fields)?;
    fs::write(explorie_json_path, json_content)?;
    Ok(())
}

/// Update custom fields for a specific file in `.explorie.json`.
///
/// Merges the provided fields into the existing `.explorie.json` file,
/// creating the file if it doesn't exist. Only the specified file's
/// fields are modified; other entries are preserved.
///
/// # Arguments
///
/// * `dir_path` - Directory containing the `.explorie.json` file
/// * `file_name` - Name of the file to update fields for (not full path)
/// * `custom_fields` - Map of field names to values
///
/// # Example
///
/// ```rust,no_run
/// use explorie_core::update_custom_fields;
/// use std::collections::HashMap;
/// use std::path::Path;
/// use serde_json::json;
///
/// let mut fields = HashMap::new();
/// fields.insert("status".to_string(), json!("In Progress"));
/// fields.insert("priority".to_string(), json!("High"));
/// fields.insert("tags".to_string(), json!(["important", "work"]));
///
/// update_custom_fields(
///     Path::new("/path/to/dir"),
///     "document.pdf",
///     fields
/// ).unwrap();
/// ```
pub fn update_custom_fields(
    dir_path: &Path,
    file_name: &str,
    custom_fields: HashMap<String, serde_json::Value>,
) -> io::Result<()> {
    let explorie_json_path = dir_path.join(".explorie.json");

    // Load existing schema or create empty one
    let mut schema = if explorie_json_path.exists() {
        match fs::read_to_string(&explorie_json_path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => HashMap::new(),
        }
    } else {
        HashMap::new()
    };

    // Update the fields for this file
    schema.insert(file_name.to_string(), custom_fields);

    // Write back to disk
    let json_content = serde_json::to_string_pretty(&schema)?;
    fs::write(explorie_json_path, json_content)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn serialize_file_entry() {
        let entry = FileEntry {
            id: Uuid::new_v4(),
            path: PathBuf::from("/tmp/foo.txt"),
            size: 1234,
            modified: SystemTime::now(),
            hidden: false,
            is_dir: false,
            custom: {
                let mut map = HashMap::new();
                map.insert("tag".to_string(), json!("important"));
                map
            },
            is_symlink: false,
            is_junction: false,
            link_target: None,
            has_xattrs: false,
        };
        let _ = serde_json::to_string(&entry).unwrap();
    }

    #[test]
    fn serialize_file_entry_symlink() {
        let entry = FileEntry {
            id: Uuid::new_v4(),
            path: PathBuf::from("/tmp/link"),
            size: 0,
            modified: SystemTime::now(),
            hidden: false,
            is_dir: false,
            custom: HashMap::new(),
            is_symlink: true,
            is_junction: false,
            link_target: Some("/tmp/target".to_string()),
            has_xattrs: false,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("is_symlink"));
        assert!(json.contains("link_target"));
    }

    #[test]
    fn test_list_dir_current() {
        let result = list_dir(Path::new("."));
        assert!(result.is_ok());
    }

    #[test]
    fn test_dir_size_deeply_nested() {
        let temp_dir = TempDir::new().unwrap();
        let mut current = temp_dir.path().to_path_buf();
        let mut total: u64 = 0;

        for i in 0..6 {
            current = current.join(format!("level_{i}"));
            fs::create_dir(&current).unwrap();
            let file_path = current.join("data.bin");
            let payload = vec![i as u8; 128 + i as usize];
            fs::write(&file_path, &payload).unwrap();
            total += payload.len() as u64;
        }

        let size = dir_size(temp_dir.path()).unwrap();
        assert_eq!(size, total);
    }

    #[cfg(unix)]
    #[test]
    fn test_dir_size_permission_denied() {
        use std::os::unix::fs::PermissionsExt;

        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();

        let allowed_dir = root.join("allowed");
        fs::create_dir(&allowed_dir).unwrap();
        let allowed_file = allowed_dir.join("ok.txt");
        fs::write(&allowed_file, b"ok").unwrap();

        let blocked_dir = root.join("blocked");
        fs::create_dir(&blocked_dir).unwrap();
        let blocked_file = blocked_dir.join("secret.txt");
        fs::write(&blocked_file, b"secret").unwrap();

        let mut perms = fs::metadata(&blocked_dir).unwrap().permissions();
        perms.set_mode(0o000);
        fs::set_permissions(&blocked_dir, perms).unwrap();

        let size = dir_size(root).unwrap();
        assert_eq!(size, 2);

        let mut restore = fs::metadata(&blocked_dir).unwrap().permissions();
        restore.set_mode(0o755);
        fs::set_permissions(&blocked_dir, restore).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn test_dir_size_symlink_cycle() {
        use std::os::unix::fs::symlink;

        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        let data_dir = root.join("data");
        fs::create_dir(&data_dir).unwrap();

        let file_path = data_dir.join("file.txt");
        fs::write(&file_path, b"abc").unwrap();

        let link_path = data_dir.join("loop");
        symlink(root, &link_path).unwrap();

        let size = dir_size(root).unwrap();
        assert_eq!(size, 3);
    }
}
