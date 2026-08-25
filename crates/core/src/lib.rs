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
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::SystemTime;

use rayon::prelude::*;
use uuid::Uuid;
use walkdir::WalkDir;

pub mod archive;
pub use archive::*;
mod file_operations;
pub use file_operations::*;

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

/// The value types supported by a typed custom-field declaration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CustomFieldType {
    String,
    Number,
    Boolean,
    StringArray,
    Date,
    Url,
    Enum,
}

/// A field definition in the optional `$schema` metadata declaration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomFieldDefinition {
    #[serde(rename = "type")]
    pub field_type: CustomFieldType,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<String>,
}

/// The typed field declarations stored under `$schema`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomFieldsSchemaDeclaration {
    #[serde(default)]
    pub fields: HashMap<String, CustomFieldDefinition>,
}

pub type CustomFieldSchema = CustomFieldsSchemaDeclaration;

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
// ponytail: one process-wide lock; use per-directory locks only after measured contention.
static CUSTOM_FIELDS_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn custom_fields_cache() -> &'static RwLock<CustomFieldsCache> {
    CUSTOM_FIELDS_CACHE.get_or_init(|| {
        RwLock::new(CustomFieldsCache {
            entries: HashMap::new(),
            order: VecDeque::new(),
        })
    })
}

fn custom_fields_write_lock() -> &'static Mutex<()> {
    CUSTOM_FIELDS_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

fn invalidate_custom_fields_cache(path: &Path) {
    let mut cache = custom_fields_cache()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.entries.remove(path);
    cache.order.retain(|cached| cached != path);
}

struct CustomFieldsDocument {
    schema_key: Option<String>,
    schema_value: Option<serde_json::Value>,
    schema: Option<CustomFieldsSchemaDeclaration>,
    entries: HashMap<String, HashMap<String, serde_json::Value>>,
}

fn metadata_error(path: &Path, message: impl Into<String>) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("Invalid {}: {}", path.display(), message.into()),
    )
}

fn parse_custom_field_type(value: &str) -> Option<CustomFieldType> {
    match value.trim().to_ascii_lowercase().replace('_', "-").as_str() {
        "string" => Some(CustomFieldType::String),
        "number" => Some(CustomFieldType::Number),
        "boolean" | "bool" => Some(CustomFieldType::Boolean),
        "string-array" | "array" | "strings" => Some(CustomFieldType::StringArray),
        "date" => Some(CustomFieldType::Date),
        "url" | "uri" => Some(CustomFieldType::Url),
        "enum" | "enumeration" => Some(CustomFieldType::Enum),
        _ => None,
    }
}

fn parse_enum_values(
    object: &serde_json::Map<String, serde_json::Value>,
    path: &Path,
    field_name: &str,
) -> io::Result<Vec<String>> {
    let value = object
        .get("values")
        .or_else(|| object.get("options"))
        .or_else(|| object.get("allowed"))
        .or_else(|| object.get("enum"));
    let Some(value) = value else {
        return Err(metadata_error(
            path,
            format!("enum field `{field_name}` must declare a non-empty values array"),
        ));
    };
    let Some(values) = value.as_array() else {
        return Err(metadata_error(
            path,
            format!("enum field `{field_name}` values must be an array of strings"),
        ));
    };
    if values.is_empty() {
        return Err(metadata_error(
            path,
            format!("enum field `{field_name}` must declare at least one value"),
        ));
    }

    values
        .iter()
        .map(|value| {
            value.as_str().map(str::to_owned).ok_or_else(|| {
                metadata_error(
                    path,
                    format!("enum field `{field_name}` values must be strings"),
                )
            })
        })
        .collect()
}

fn parse_custom_field_definition(
    field_name: &str,
    value: &serde_json::Value,
    path: &Path,
) -> io::Result<CustomFieldDefinition> {
    match value {
        serde_json::Value::String(type_name) => {
            let field_type = parse_custom_field_type(type_name).ok_or_else(|| {
                metadata_error(
                    path,
                    format!("unknown type `{type_name}` for field `{field_name}`"),
                )
            })?;
            if field_type == CustomFieldType::Enum {
                return Err(metadata_error(
                    path,
                    format!("enum field `{field_name}` must declare values"),
                ));
            }
            Ok(CustomFieldDefinition {
                field_type,
                required: false,
                values: Vec::new(),
            })
        }
        serde_json::Value::Array(values) => {
            if values.is_empty() || values.iter().any(|value| !value.is_string()) {
                return Err(metadata_error(
                    path,
                    format!("enum field `{field_name}` values must be a non-empty string array"),
                ));
            }
            Ok(CustomFieldDefinition {
                field_type: CustomFieldType::Enum,
                required: false,
                values: values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            })
        }
        serde_json::Value::Object(object) => {
            let field_type = object
                .get("type")
                .or_else(|| object.get("fieldType"))
                .and_then(serde_json::Value::as_str)
                .or_else(|| {
                    (object.contains_key("enum")
                        || object.contains_key("values")
                        || object.contains_key("options")
                        || object.contains_key("allowed"))
                    .then_some("enum")
                })
                .and_then(parse_custom_field_type)
                .ok_or_else(|| {
                    metadata_error(
                        path,
                        format!("field `{field_name}` must declare a supported type"),
                    )
                })?;
            let required = match object.get("required") {
                None => false,
                Some(value) => value.as_bool().ok_or_else(|| {
                    metadata_error(
                        path,
                        format!("field `{field_name}` required must be a boolean"),
                    )
                })?,
            };
            let values = if field_type == CustomFieldType::Enum {
                parse_enum_values(object, path, field_name)?
            } else {
                Vec::new()
            };

            Ok(CustomFieldDefinition {
                field_type,
                required,
                values,
            })
        }
        _ => Err(metadata_error(
            path,
            format!("field `{field_name}` declaration must be a type or object"),
        )),
    }
}

fn parse_required_fields(
    value: &serde_json::Value,
    declarations: &mut HashMap<String, CustomFieldDefinition>,
    path: &Path,
) -> io::Result<()> {
    match value {
        serde_json::Value::Array(fields) => {
            for field in fields {
                let field_name = field.as_str().ok_or_else(|| {
                    metadata_error(path, "schema required entries must be strings")
                })?;
                let declaration = declarations.get_mut(field_name).ok_or_else(|| {
                    metadata_error(
                        path,
                        format!("required field `{field_name}` has no type declaration"),
                    )
                })?;
                declaration.required = true;
            }
        }
        serde_json::Value::Object(fields) => {
            for (field_name, required) in fields {
                let required = required.as_bool().ok_or_else(|| {
                    metadata_error(
                        path,
                        format!("required flag for field `{field_name}` must be a boolean"),
                    )
                })?;
                if !required {
                    continue;
                }
                let declaration = declarations.get_mut(field_name).ok_or_else(|| {
                    metadata_error(
                        path,
                        format!("required field `{field_name}` has no type declaration"),
                    )
                })?;
                declaration.required = true;
            }
        }
        _ => {
            return Err(metadata_error(
                path,
                "schema required must be an array or object",
            ));
        }
    }
    Ok(())
}

fn parse_schema_declaration(
    value: &serde_json::Value,
    path: &Path,
) -> io::Result<CustomFieldsSchemaDeclaration> {
    let object = value
        .as_object()
        .ok_or_else(|| metadata_error(path, "schema declaration must be an object"))?;
    let mut fields = HashMap::new();
    if let Some(declarations) = object.get("fields").or_else(|| object.get("types")) {
        if let Some(declarations) = declarations.as_object() {
            for (field_name, definition) in declarations {
                fields.insert(
                    field_name.clone(),
                    parse_custom_field_definition(field_name, definition, path)?,
                );
            }
        } else if let Some(declarations) = declarations.as_array() {
            for declaration in declarations {
                let declaration = declaration
                    .as_object()
                    .ok_or_else(|| metadata_error(path, "schema fields entries must be objects"))?;
                let field_name = declaration
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| metadata_error(path, "schema fields entries need a name"))?;
                fields.insert(
                    field_name.to_string(),
                    parse_custom_field_definition(
                        field_name,
                        &serde_json::Value::Object(declaration.clone()),
                        path,
                    )?,
                );
            }
        } else {
            return Err(metadata_error(
                path,
                "schema fields must be an object or array",
            ));
        }
    } else {
        for (field_name, definition) in object {
            if field_name == "required" {
                continue;
            }
            fields.insert(
                field_name.clone(),
                parse_custom_field_definition(field_name, definition, path)?,
            );
        }
    }

    if let Some(required) = object.get("required") {
        parse_required_fields(required, &mut fields, path)?;
    }

    Ok(CustomFieldsSchemaDeclaration { fields })
}

fn is_schema_marker(key: &str, value: &serde_json::Value) -> bool {
    // `$schema` is the documented opt-in marker. Do not reserve look-alike
    // filenames such as `schema` or `__schema`: older metadata may contain
    // entries with those names and must continue to load unchanged.
    key == "$schema" && value.is_object()
}

fn parse_custom_fields_document(
    value: serde_json::Value,
    path: &Path,
) -> io::Result<CustomFieldsDocument> {
    let object = value
        .as_object()
        .ok_or_else(|| metadata_error(path, "metadata root must be an object"))?;
    let mut schema_key = None;
    let mut schema_value = None;
    let mut schema = None;
    let mut entries = HashMap::new();

    for (key, value) in object {
        if is_schema_marker(key, value) {
            if schema.is_some() {
                return Err(metadata_error(
                    path,
                    "metadata contains more than one schema",
                ));
            }
            schema_key = Some(key.clone());
            schema_value = Some(value.clone());
            schema = Some(parse_schema_declaration(value, path)?);
            continue;
        }

        let fields = value.as_object().ok_or_else(|| {
            metadata_error(path, format!("metadata entry `{key}` must be an object"))
        })?;
        entries.insert(
            key.clone(),
            fields
                .iter()
                .map(|(field, value)| (field.clone(), value.clone()))
                .collect(),
        );
    }

    let document = CustomFieldsDocument {
        schema_key,
        schema_value,
        schema,
        entries,
    };
    validate_custom_fields_document(&document, path)?;
    Ok(document)
}

fn custom_value_kind(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

fn custom_field_type_label(field_type: CustomFieldType) -> &'static str {
    match field_type {
        CustomFieldType::String => "string",
        CustomFieldType::Number => "number",
        CustomFieldType::Boolean => "boolean",
        CustomFieldType::StringArray => "string-array",
        CustomFieldType::Date => "date (YYYY-MM-DD)",
        CustomFieldType::Url => "url",
        CustomFieldType::Enum => "enum",
    }
}

fn is_valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return false;
    }
    let year = value[0..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..10].parse::<u32>().unwrap_or(0);
    if year == 0 || !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap_year => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    day <= days_in_month
}

fn is_valid_url(value: &str) -> bool {
    if value.is_empty()
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return false;
    }

    let Ok(url) = url::Url::parse(value) else {
        return false;
    };

    // Keep this in step with the UI's `new URL(value)` plus hostname check:
    // schemes without a host (for example `mailto:` and `file:`) are not
    // accepted as metadata URLs, while malformed ports are rejected by the
    // parser instead of being treated as part of the hostname.
    !url.scheme().is_empty() && url.host_str().is_some_and(|host| !host.is_empty())
}

fn validate_custom_field_value(
    value: &serde_json::Value,
    definition: &CustomFieldDefinition,
) -> Result<(), String> {
    let valid = match definition.field_type {
        CustomFieldType::String => value.is_string(),
        CustomFieldType::Number => value.is_number(),
        CustomFieldType::Boolean => value.is_boolean(),
        CustomFieldType::StringArray => value
            .as_array()
            .map(|values| values.iter().all(serde_json::Value::is_string))
            .unwrap_or(false),
        CustomFieldType::Date => value.as_str().is_some_and(is_valid_date),
        CustomFieldType::Url => value.as_str().is_some_and(is_valid_url),
        CustomFieldType::Enum => value
            .as_str()
            .is_some_and(|value| definition.values.iter().any(|allowed| allowed == value)),
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "expected {}, got {}",
            custom_field_type_label(definition.field_type),
            custom_value_kind(value)
        ))
    }
}

fn is_legacy_custom_field_value(value: &serde_json::Value) -> bool {
    value.is_null()
        || value.is_string()
        || value.is_number()
        || value.is_boolean()
        || value
            .as_array()
            .map(|values| values.iter().all(serde_json::Value::is_string))
            .unwrap_or(false)
}

fn validate_custom_fields_document(document: &CustomFieldsDocument, path: &Path) -> io::Result<()> {
    let Some(schema) = document.schema.as_ref() else {
        return Ok(());
    };

    for (file_name, fields) in &document.entries {
        for (field_name, definition) in &schema.fields {
            let Some(value) = fields.get(field_name) else {
                if definition.required {
                    return Err(metadata_error(
                        path,
                        format!("field `{file_name}.{field_name}` is required"),
                    ));
                }
                continue;
            };
            validate_custom_field_value(value, definition).map_err(|reason| {
                metadata_error(path, format!("field `{file_name}.{field_name}` {reason}"))
            })?;
        }
        for (field_name, value) in fields {
            if !schema.fields.contains_key(field_name) && !is_legacy_custom_field_value(value) {
                return Err(metadata_error(
                    path,
                    format!(
                        "field `{file_name}.{field_name}` expected a supported custom value, got {}",
                        custom_value_kind(value)
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn custom_fields_document_value(document: &CustomFieldsDocument) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    if let (Some(schema_key), Some(schema_value)) =
        (document.schema_key.as_ref(), document.schema_value.as_ref())
    {
        object.insert(schema_key.clone(), schema_value.clone());
    }
    for (file_name, fields) in &document.entries {
        object.insert(
            file_name.clone(),
            serde_json::Value::Object(fields.clone().into_iter().collect()),
        );
    }
    serde_json::Value::Object(object)
}

/// Load custom fields from .explorie.json file in a directory.
///
/// Invalid metadata is returned to the caller instead of being treated as an
/// empty schema; silently doing that would allow the next update to erase it.
fn load_custom_fields(
    dir_path: &Path,
) -> io::Result<HashMap<String, HashMap<String, serde_json::Value>>> {
    let explorie_json_path = dir_path.join(".explorie.json");
    if !explorie_json_path.exists() {
        invalidate_custom_fields_cache(&explorie_json_path);
        return Ok(HashMap::new());
    }

    let modified = fs::metadata(&explorie_json_path)
        .ok()
        .and_then(|metadata| metadata.modified().ok());

    if let Ok(cache) = custom_fields_cache().read()
        && let Some(entry) = cache.entries.get(&explorie_json_path)
        && modified.is_some()
        && entry.modified == modified
    {
        return Ok(entry.fields.clone());
    }

    let content = fs::read_to_string(&explorie_json_path)?;
    let parsed_value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| metadata_error(&explorie_json_path, error.to_string()))?;
    let document = parse_custom_fields_document(parsed_value, &explorie_json_path)?;
    let parsed = document.entries;

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

    Ok(parsed)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn write_custom_fields_atomic(dir_path: &Path, fields: &serde_json::Value) -> io::Result<()> {
    let destination = dir_path.join(".explorie.json");
    let temporary = dir_path.join(format!(".explorie.{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(fields)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, &destination)?;
        invalidate_custom_fields_cache(&destination);

        #[cfg(unix)]
        fs::File::open(dir_path)?.sync_all()?;

        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Check if a file has extended attributes (macOS xattrs, Windows ADS).
/// This is a best-effort check that returns false if unable to determine.
fn has_extended_attributes(_path: &Path, _metadata: &fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        // Use listxattr to check if there are any xattrs
        let c_path = match CString::new(_path.as_os_str().as_bytes()) {
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
        const FILE_ATTRIBUTE_SPARSE_FILE: u32 = 0x200;
        // This is a simplified check - true ADS detection requires Win32 API
        (_metadata.file_attributes() & FILE_ATTRIBUTE_SPARSE_FILE) != 0
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        // On Linux, use listxattr
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let c_path = match CString::new(_path.as_os_str().as_bytes()) {
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
    let root_metadata = fs::symlink_metadata(path)?;
    if is_link_metadata(&root_metadata) {
        return Ok(0);
    }
    if root_metadata.is_file() {
        return Ok(root_metadata.len());
    }

    let mut total: u64 = 0;
    let mut entries = WalkDir::new(path).follow_links(false).into_iter();
    while let Some(entry) = entries.next() {
        let entry = entry.map_err(io::Error::other)?;
        let metadata = entry.path().symlink_metadata()?;
        if is_link_metadata(&metadata) {
            if metadata.is_dir() {
                entries.skip_current_dir();
            }
        } else if metadata.is_file() {
            total = total.saturating_add(metadata.len());
        }
    }

    Ok(total)
}

/// Return the recursive entry count and byte size without following links.
pub fn dir_info(path: &Path) -> io::Result<(u64, u64)> {
    let metadata = fs::symlink_metadata(path)?;
    if is_link_metadata(&metadata) || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "directory info requires a real directory",
        ));
    }
    fs::read_dir(path)?;

    let mut count = 0;
    let mut size = 0;
    let mut entries = WalkDir::new(path).follow_links(false).into_iter();
    let _ = entries.next();
    while let Some(entry) = entries.next() {
        let entry = entry.map_err(io::Error::other)?;
        count += 1;
        let metadata = entry.path().symlink_metadata()?;
        if is_link_metadata(&metadata) {
            if metadata.is_dir() {
                entries.skip_current_dir();
            }
        } else if metadata.is_file() {
            size += metadata.len();
        }
    }
    Ok((count, size))
}

fn is_link_metadata(metadata: &fs::Metadata) -> bool {
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
    let custom_fields = load_custom_fields(path)?;
    let dir_entries: Vec<fs::DirEntry> = fs::read_dir(path)?.collect::<io::Result<_>>()?;

    let results: Vec<io::Result<Option<FileEntry>>> = dir_entries
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
            let has_xattrs = has_extended_attributes(&entry.path(), &symlink_meta);

            // Use link metadata throughout so dangling links remain listable and
            // directory links are never traversed as real directories.
            let metadata = symlink_meta;
            let file_type = metadata.file_type();
            let is_dir = !is_symlink && !is_junction && file_type.is_dir();

            // Calculate size - don't follow symlinks/junctions for size calculation
            let size = if is_symlink || is_junction {
                // For links, just use the link's own size
                metadata.len()
            } else if file_type.is_file() {
                metadata.len()
            } else if is_dir && calc_dir_size {
                dir_size(&entry.path())?
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
        .collect();

    Ok(results
        .into_iter()
        .collect::<io::Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect())
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
/// * `fields` - Map of filename -> field map. An optional `$schema` entry may
///   contain `fields` with typed declarations and `required` flags.
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
    let metadata = serde_json::to_value(fields)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let metadata_path = dir_path.join(".explorie.json");
    let document = parse_custom_fields_document(metadata, &metadata_path)?;
    let _guard = custom_fields_write_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    write_custom_fields_atomic(dir_path, &custom_fields_document_value(&document))
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
    update_custom_fields_batch(
        dir_path,
        HashMap::from([(file_name.to_string(), custom_fields)]),
    )
}

/// Update custom fields for multiple files with one validated atomic write.
///
/// Every update replaces the complete field map for its file. All updates are
/// validated against the directory's optional schema before `.explorie.json`
/// is replaced, so a rejected item leaves every existing entry untouched.
pub fn update_custom_fields_batch(
    dir_path: &Path,
    updates: HashMap<String, HashMap<String, serde_json::Value>>,
) -> io::Result<()> {
    if updates.is_empty() {
        return Ok(());
    }

    let explorie_json_path = dir_path.join(".explorie.json");
    let _guard = custom_fields_write_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    let mut document = if explorie_json_path.exists() {
        let content = fs::read_to_string(&explorie_json_path)?;
        let metadata: serde_json::Value = serde_json::from_str(&content)
            .map_err(|error| metadata_error(&explorie_json_path, error.to_string()))?;
        parse_custom_fields_document(metadata, &explorie_json_path)?
    } else {
        CustomFieldsDocument {
            schema_key: None,
            schema_value: None,
            schema: None,
            entries: HashMap::new(),
        }
    };

    for (file_name, custom_fields) in updates {
        document.entries.insert(file_name, custom_fields);
    }
    validate_custom_fields_document(&document, &explorie_json_path)?;

    write_custom_fields_atomic(dir_path, &custom_fields_document_value(&document))
}

/// Read the optional typed custom-field schema for a directory.
pub fn get_custom_fields_schema(
    dir_path: &Path,
) -> io::Result<Option<CustomFieldsSchemaDeclaration>> {
    let metadata_path = dir_path.join(".explorie.json");
    if !metadata_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&metadata_path)?;
    let metadata: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| metadata_error(&metadata_path, error.to_string()))?;
    Ok(parse_custom_fields_document(metadata, &metadata_path)?.schema)
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
    fn recursive_inspection_reports_unreadable_entries() {
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

        // Elevated test runners can still read mode-000 directories.
        if fs::read_dir(&blocked_dir).is_ok() {
            let mut restore = fs::metadata(&blocked_dir).unwrap().permissions();
            restore.set_mode(0o755);
            fs::set_permissions(&blocked_dir, restore).unwrap();
            return;
        }

        let size_result = dir_size(root);
        let info_result = dir_info(root);
        let listing_result = list_dir_with_sizes(root, true);

        let mut restore = fs::metadata(&blocked_dir).unwrap().permissions();
        restore.set_mode(0o755);
        fs::set_permissions(&blocked_dir, restore).unwrap();

        assert!(size_result.is_err());
        assert!(info_result.is_err());
        assert!(listing_result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_dir_size_symlink_cycle() {
        use std::os::unix::fs::symlink;

        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        let data_dir = root.join("data");
        fs::create_dir(&data_dir).unwrap();

        let link_path = data_dir.join("loop");
        symlink(root, &link_path).unwrap();

        let file_path = data_dir.join("file.txt");
        fs::write(&file_path, b"abc").unwrap();

        let size = dir_size(root).unwrap();
        assert_eq!(size, 3);
    }
}
