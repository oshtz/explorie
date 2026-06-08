// Prevents a terminal window from appearing on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use explorie_core::archive::{
    ArchiveFormat, ArchiveInfo, ArchiveProgress, CompressOptions, CompressionLevel,
    create_archive_with_progress, extract_archive, is_archive, list_archive_contents,
};
use explorie_ffmpeg_wrapper::FfmpegTask;
use explorie_plugin_host::{Plugin, PluginError, PluginHost};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[cfg(target_os = "windows")]
mod default_file_manager {
    use std::io;
    use std::path::Path;
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};

    const HANDLER_VALUE: &str = "explorie";
    const HANDLER_LABEL: &str = "explorie";
    const TARGET_CLASSES: [&str; 3] = ["Directory", "Drive", "Folder"];

    fn shell_path(target: &str) -> String {
        format!("Software\\Classes\\{}\\shell", target)
    }

    fn command_value(exe: &Path) -> String {
        let display = exe.to_string_lossy();
        format!("\"{}\" \"%1\"", display)
    }

    pub fn is_default() -> io::Result<bool> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for class in TARGET_CLASSES {
            let path = shell_path(class);
            let key = match hkcu.open_subkey_with_flags(&path, KEY_READ) {
                Ok(k) => k,
                Err(_) => return Ok(false),
            };
            match key.get_value::<String, _>("") {
                Ok(value) if value.eq_ignore_ascii_case(HANDLER_VALUE) => {}
                _ => return Ok(false),
            }
        }
        Ok(true)
    }

    pub fn set_default() -> io::Result<()> {
        let exe = std::env::current_exe()?;
        let command = command_value(&exe);
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        for class in TARGET_CLASSES {
            let path = shell_path(class);
            let (shell_key, _) = hkcu.create_subkey(&path)?;
            shell_key.set_value("", &HANDLER_VALUE)?;

            let (handler_key, _) = shell_key.create_subkey(HANDLER_VALUE)?;
            handler_key.set_value("", &HANDLER_LABEL)?;
            let _ = handler_key.delete_value("DelegateExecute");
            let (command_key, _) = handler_key.create_subkey("command")?;
            command_key.set_value("", &command)?;
        }

        Ok(())
    }

    pub fn revert_default() -> io::Result<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        for class in TARGET_CLASSES {
            let path = shell_path(class);
            if let Ok(shell_key) = hkcu.open_subkey_with_flags(&path, KEY_READ | KEY_WRITE) {
                if let Ok(value) = shell_key.get_value::<String, _>("")
                    && value.eq_ignore_ascii_case(HANDLER_VALUE)
                {
                    let _ = shell_key.delete_value("");
                }
                let _ = shell_key.delete_subkey_all(HANDLER_VALUE);
            }
        }

        Ok(())
    }
}

// --- Plugin host wiring ---
static PLUGIN_HOST: OnceLock<PluginHost> = OnceLock::new();

fn plugin_host() -> &'static PluginHost {
    PLUGIN_HOST.get_or_init(|| {
        let host = PluginHost::new();
        let _ = host.register(InfoPlugin);
        host
    })
}

struct InfoPlugin;

impl Plugin for InfoPlugin {
    fn name(&self) -> &str {
        "info"
    }

    fn invoke(&self, method: &str, payload: Option<Value>) -> Result<Value, PluginError> {
        match method {
            "ping" => Ok(json!({ "ok": true })),
            "summary" => {
                let path = payload
                    .as_ref()
                    .and_then(|v| v.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(".");
                let entries = explorie_core::list_dir(Path::new(path)).map_err(|e| {
                    PluginError::Invocation {
                        plugin: self.name().into(),
                        method: method.into(),
                        message: e.to_string(),
                    }
                })?;
                let mut dirs = 0usize;
                let mut files = 0usize;
                for e in &entries {
                    if e.is_dir {
                        dirs += 1;
                    } else {
                        files += 1;
                    }
                }
                Ok(json!({
                    "path": path,
                    "entries": entries.len(),
                    "dirs": dirs,
                    "files": files
                }))
            }
            other => Err(PluginError::MethodNotFound {
                plugin: self.name().into(),
                method: other.into(),
            }),
        }
    }

    fn methods(&self) -> &[&'static str] {
        &["ping", "summary"]
    }
}

#[tauri::command]
async fn list_files(
    path: String,
    calc_dir_size: Option<bool>,
) -> Result<Vec<explorie_core::FileEntry>, String> {
    let calc = calc_dir_size.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        explorie_core::list_dir_with_sizes(p, calc)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_explorie_schema(
    dir_path: String,
    fields: HashMap<String, HashMap<String, Value>>,
) -> Result<(), String> {
    let path = Path::new(&dir_path);
    explorie_core::create_explorie_schema(path, fields).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_custom_fields(
    dir_path: String,
    file_name: String,
    custom_fields: HashMap<String, Value>,
) -> Result<(), String> {
    let path = Path::new(&dir_path);
    explorie_core::update_custom_fields(path, &file_name, custom_fields).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct SystemLocations {
    desktop: Option<String>,
    documents: Option<String>,
    downloads: Option<String>,
    music: Option<String>,
    pictures: Option<String>,
    videos: Option<String>,
    home: Option<String>,
    drives: Vec<String>,
}

#[derive(Serialize)]
struct DiskInfo {
    mount_point: String,
    total_space: u64,
    available_space: u64,
    name: String,
}

#[derive(Serialize)]
struct FfmpegPreview {
    binary: String,
    args: Vec<String>,
}

#[derive(Serialize)]
struct PreviewArtifact {
    kind: String,
    path: String,
    mime_type: String,
    tool: String,
}

#[tauri::command]
fn list_system_locations() -> Result<SystemLocations, String> {
    use dirs::*;
    use sysinfo::Disks;

    let desktop = desktop_dir().map(|p| p.to_string_lossy().to_string());
    let documents = document_dir().map(|p| p.to_string_lossy().to_string());
    let downloads = download_dir().map(|p| p.to_string_lossy().to_string());
    let music = audio_dir().map(|p| p.to_string_lossy().to_string());
    let pictures = picture_dir().map(|p| p.to_string_lossy().to_string());
    let videos = video_dir().map(|p| p.to_string_lossy().to_string());
    let home = home_dir().map(|p| p.to_string_lossy().to_string());

    let disks = Disks::new_with_refreshed_list();
    let drives = disks
        .iter()
        .map(|d| d.mount_point().to_string_lossy().to_string())
        .collect();

    Ok(SystemLocations {
        desktop,
        documents,
        downloads,
        music,
        pictures,
        videos,
        home,
        drives,
    })
}

#[tauri::command]
fn get_disk_info(path: String) -> Result<DiskInfo, String> {
    use std::path::Path;
    use sysinfo::Disks;

    let target_path = Path::new(&path);
    let disks = Disks::new_with_refreshed_list();

    // Find the disk that contains this path by checking mount points
    let mut best_match: Option<&sysinfo::Disk> = None;
    let mut best_match_len = 0;

    for disk in disks.iter() {
        let mount = disk.mount_point();
        // Check if the path starts with this mount point
        if target_path.starts_with(mount) {
            let mount_len = mount.to_string_lossy().len();
            if mount_len > best_match_len {
                best_match = Some(disk);
                best_match_len = mount_len;
            }
        }
    }

    match best_match {
        Some(disk) => Ok(DiskInfo {
            mount_point: disk.mount_point().to_string_lossy().to_string(),
            total_space: disk.total_space(),
            available_space: disk.available_space(),
            name: disk.name().to_string_lossy().to_string(),
        }),
        None => Err("Could not find disk for the given path".to_string()),
    }
}

#[tauri::command]
fn list_plugins() -> Result<Vec<String>, String> {
    Ok(plugin_host().list())
}

#[tauri::command]
fn call_plugin(plugin: String, method: String, payload: Option<Value>) -> Result<Value, String> {
    plugin_host()
        .call(&plugin, &method, payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_plugin_methods(plugin: String) -> Result<Vec<String>, String> {
    plugin_host().methods(&plugin).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_dir_size(path: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        explorie_core::dir_size(p)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct DirInfo {
    count: u64,
    size: u64,
}

/// Get directory info (item count and total size) for secure delete confirmation
#[tauri::command]
async fn get_dir_info(path: String) -> Result<DirInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        let mut count: u64 = 0;
        let mut size: u64 = 0;

        fn walk_dir(path: &Path, count: &mut u64, size: &mut u64) {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.filter_map(|e| e.ok()) {
                    *count += 1;
                    let entry_path = entry.path();
                    if let Ok(metadata) = entry.metadata() {
                        if metadata.is_dir() {
                            walk_dir(&entry_path, count, size);
                        } else {
                            *size += metadata.len();
                        }
                    }
                }
            }
        }

        walk_dir(p, &mut count, &mut size);
        Ok(DirInfo { count, size })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    // Launch using OS default handler; detached to avoid blocking the app.
    open::that_detached(&path).map_err(|e| e.to_string())
}

/// Reveal a file or folder in the native file manager (Finder on macOS, Explorer on Windows)
#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path]) // -R reveals the file in Finder
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        // Use explorer with /select to highlight the file
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = path;
        Err("Reveal in file manager is not supported on this platform.".to_string())
    }
}

/// Open Quick Look preview for a file (macOS only)
#[cfg(target_os = "macos")]
#[tauri::command]
fn quick_look(path: String) -> Result<(), String> {
    Command::new("qlmanage")
        .args(["-p", &path])
        .spawn()
        .map_err(|e| format!("Failed to open Quick Look: {}", e))?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn quick_look(_path: String) -> Result<(), String> {
    Err("Quick Look is only available on macOS.".to_string())
}

/// Get Finder tags for a file (macOS only)
/// Returns a list of tag names
#[cfg(target_os = "macos")]
#[tauri::command]
fn get_finder_tags(path: String) -> Result<Vec<String>, String> {
    use std::ffi::CString;

    let c_path = CString::new(path.as_bytes()).map_err(|_| "Invalid path")?;

    // Get the com.apple.metadata:_kMDItemUserTags xattr
    let attr_name = CString::new("com.apple.metadata:_kMDItemUserTags")
        .map_err(|_| "Invalid attribute name")?;

    // First, get the size of the xattr value
    let size = unsafe {
        libc::getxattr(
            c_path.as_ptr(),
            attr_name.as_ptr(),
            std::ptr::null_mut(),
            0,
            0,
            libc::XATTR_NOFOLLOW,
        )
    };

    if size < 0 {
        // No tags or error - return empty list
        return Ok(Vec::new());
    }

    // Allocate buffer and read the xattr
    let mut buffer = vec![0u8; size as usize];
    let read_size = unsafe {
        libc::getxattr(
            c_path.as_ptr(),
            attr_name.as_ptr(),
            buffer.as_mut_ptr() as *mut libc::c_void,
            size as usize,
            0,
            libc::XATTR_NOFOLLOW,
        )
    };

    if read_size < 0 {
        return Ok(Vec::new());
    }

    // Parse the plist data - tags are stored as a binary plist array
    // For simplicity, we'll use the mdls command which is more reliable
    let output = Command::new("mdls")
        .args(["-name", "kMDItemUserTags", "-raw", &path])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Parse the output which looks like: (tag1, tag2, tag3) or (null)
    let tags: Vec<String> = stdout
        .trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .split(',')
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty() && s != "null")
        .collect();

    Ok(tags)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn get_finder_tags(_path: String) -> Result<Vec<String>, String> {
    // Return empty list on non-macOS platforms
    Ok(Vec::new())
}

/// Set Finder tags for a file (macOS only)
#[cfg(target_os = "macos")]
#[tauri::command]
fn set_finder_tags(path: String, tags: Vec<String>) -> Result<(), String> {
    // Use xattr command to set tags (more reliable than direct xattr manipulation)
    // Tags are stored in com.apple.metadata:_kMDItemUserTags as a binary plist

    // First, clear existing tags by removing the xattr
    let _ = Command::new("xattr")
        .args(["-d", "com.apple.metadata:_kMDItemUserTags", &path])
        .output();

    if tags.is_empty() {
        return Ok(());
    }

    // Create a plist array string
    let tags_plist: Vec<String> = tags
        .iter()
        .map(|t| {
            format!(
                "<string>{}</string>",
                t.replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
            )
        })
        .collect();

    let plist_content = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
{}
</array>
</plist>"#,
        tags_plist.join("\n")
    );

    // Write to a temp file and use xattr to set it
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("explorie_tags_{}.plist", std::process::id()));

    std::fs::write(&temp_file, plist_content)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;

    // Convert plist to binary and set as xattr
    let output = Command::new("plutil")
        .args(["-convert", "binary1", temp_file.to_string_lossy().as_ref()])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&temp_file);
        return Err("Failed to convert plist to binary".to_string());
    }

    // Read the binary plist
    let binary_data =
        std::fs::read(&temp_file).map_err(|e| format!("Failed to read binary plist: {}", e))?;

    let _ = std::fs::remove_file(&temp_file);

    // Set the xattr using the xattr command with hex encoding
    use std::ffi::CString;
    let c_path = CString::new(path.as_bytes()).map_err(|_| "Invalid path")?;
    let attr_name = CString::new("com.apple.metadata:_kMDItemUserTags")
        .map_err(|_| "Invalid attribute name")?;

    let result = unsafe {
        libc::setxattr(
            c_path.as_ptr(),
            attr_name.as_ptr(),
            binary_data.as_ptr() as *const libc::c_void,
            binary_data.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };

    if result < 0 {
        return Err(format!(
            "Failed to set xattr: {}",
            std::io::Error::last_os_error()
        ));
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn set_finder_tags(_path: String, _tags: Vec<String>) -> Result<(), String> {
    Err("Finder tags are only available on macOS.".to_string())
}

/// Get available Finder tag colors (macOS only)
/// Returns a mapping of color names to their index
#[tauri::command]
fn get_finder_tag_colors() -> Result<HashMap<String, u8>, String> {
    let mut colors = HashMap::new();
    colors.insert("None".to_string(), 0);
    colors.insert("Gray".to_string(), 1);
    colors.insert("Green".to_string(), 2);
    colors.insert("Purple".to_string(), 3);
    colors.insert("Blue".to_string(), 4);
    colors.insert("Yellow".to_string(), 5);
    colors.insert("Red".to_string(), 6);
    colors.insert("Orange".to_string(), 7);
    Ok(colors)
}

/// Open a file with a specific application (macOS only)
/// Uses the `open` command with -a flag to specify the application
#[cfg(target_os = "macos")]
#[tauri::command]
fn open_with_app(path: String, app_name: String) -> Result<(), String> {
    Command::new("open")
        .args(["-a", &app_name, &path])
        .spawn()
        .map_err(|e| format!("Failed to open with {}: {}", app_name, e))?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn open_with_app(_path: String, _app_name: String) -> Result<(), String> {
    Err("Open With is only available on macOS.".to_string())
}

#[derive(Debug, Clone, Serialize)]
struct AppInfo {
    name: String,
    path: String,
    bundle_id: Option<String>,
}

/// Get list of applications that can open a specific file type (macOS only)
#[cfg(target_os = "macos")]
#[tauri::command]
fn get_apps_for_file(path: String) -> Result<Vec<AppInfo>, String> {
    use std::collections::HashSet;

    // Use mdfind to find apps that can open this file type based on UTI
    // First, get the UTI for the file
    let output = Command::new("mdls")
        .args(["-name", "kMDItemContentType", "-raw", &path])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let uti = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if uti.is_empty() || uti == "(null)" {
        return Ok(Vec::new());
    }

    // Query Launch Services for apps that can open this UTI
    // We use a combination of approaches for better results
    let _output = Command::new("mdfind")
        .args(["kMDItemContentTypeTree", "=", &format!("'{}'", uti)])
        .output();

    let mut apps: Vec<AppInfo> = Vec::new();
    let mut seen_names: HashSet<String> = HashSet::new();

    // Add common applications based on file extension
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Common apps for different file types
    let common_apps: Vec<(&str, &str)> = match ext.as_str() {
        "txt" | "md" | "json" | "js" | "ts" | "py" | "rs" | "go" | "html" | "css" => {
            vec![
                ("TextEdit", "/System/Applications/TextEdit.app"),
                ("Visual Studio Code", "/Applications/Visual Studio Code.app"),
                ("Sublime Text", "/Applications/Sublime Text.app"),
                ("BBEdit", "/Applications/BBEdit.app"),
                ("Xcode", "/Applications/Xcode.app"),
            ]
        }
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "heic" => {
            vec![
                ("Preview", "/System/Applications/Preview.app"),
                ("Photos", "/System/Applications/Photos.app"),
                ("Pixelmator Pro", "/Applications/Pixelmator Pro.app"),
                (
                    "Adobe Photoshop",
                    "/Applications/Adobe Photoshop 2024/Adobe Photoshop 2024.app",
                ),
            ]
        }
        "pdf" => {
            vec![
                ("Preview", "/System/Applications/Preview.app"),
                (
                    "Adobe Acrobat Reader",
                    "/Applications/Adobe Acrobat Reader.app",
                ),
            ]
        }
        "mp4" | "mov" | "avi" | "mkv" | "webm" => {
            vec![
                (
                    "QuickTime Player",
                    "/System/Applications/QuickTime Player.app",
                ),
                ("VLC", "/Applications/VLC.app"),
                ("IINA", "/Applications/IINA.app"),
            ]
        }
        "mp3" | "wav" | "flac" | "aac" | "m4a" => {
            vec![
                ("Music", "/System/Applications/Music.app"),
                (
                    "QuickTime Player",
                    "/System/Applications/QuickTime Player.app",
                ),
                ("VLC", "/Applications/VLC.app"),
            ]
        }
        "zip" | "tar" | "gz" | "7z" | "rar" => {
            vec![
                (
                    "Archive Utility",
                    "/System/Library/CoreServices/Applications/Archive Utility.app",
                ),
                ("The Unarchiver", "/Applications/The Unarchiver.app"),
                ("Keka", "/Applications/Keka.app"),
            ]
        }
        _ => vec![],
    };

    for (name, app_path) in common_apps {
        if std::path::Path::new(app_path).exists() && !seen_names.contains(name) {
            seen_names.insert(name.to_string());
            apps.push(AppInfo {
                name: name.to_string(),
                path: app_path.to_string(),
                bundle_id: None,
            });
        }
    }

    Ok(apps)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn get_apps_for_file(_path: String) -> Result<Vec<AppInfo>, String> {
    Ok(Vec::new())
}

#[tauri::command]
fn ffmpeg_preview(
    input: String,
    output: String,
    copy_audio: Option<bool>,
    copy_video: Option<bool>,
    video_filters: Option<Vec<String>>,
    audio_filters: Option<Vec<String>>,
) -> Result<FfmpegPreview, String> {
    let mut task = FfmpegTask::new(&input, &output);
    if copy_audio.unwrap_or(false) {
        task = task.copy_audio(true);
    }
    if copy_video.unwrap_or(false) {
        task = task.copy_video(true);
    }
    if let Some(filters) = video_filters {
        for f in filters {
            task = task.add_video_filter(f);
        }
    }
    if let Some(filters) = audio_filters {
        for f in filters {
            task = task.add_audio_filter(f);
        }
    }
    let cmd = task.build();
    Ok(FfmpegPreview {
        binary: cmd.binary.to_string_lossy().to_string(),
        args: cmd.args,
    })
}

fn path_extension_lower(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_external_document_preview(path: &Path) -> bool {
    matches!(
        path_extension_lower(path).as_str(),
        "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp" | "rtf"
    )
}

fn is_external_video_preview(path: &Path) -> bool {
    matches!(
        path_extension_lower(path).as_str(),
        "mov" | "avi" | "mkv" | "wmv" | "flv" | "m2ts" | "mts" | "mpeg" | "mpg" | "3gp"
    )
}

fn is_external_image_preview(path: &Path) -> bool {
    matches!(
        path_extension_lower(path).as_str(),
        "heic" | "heif" | "tif" | "tiff" | "psd"
    )
}

fn preview_cache_dir() -> PathBuf {
    std::env::temp_dir().join("explorie-preview-cache")
}

fn sanitize_preview_stem(path: &Path) -> String {
    let raw = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("preview");
    let safe: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = safe.trim_matches('_');
    if trimmed.is_empty() {
        "preview".to_string()
    } else {
        trimmed.to_string()
    }
}

fn preview_cache_output_path(path: &Path, output_ext: &str) -> PathBuf {
    preview_cache_dir().join(format!("{}.{}", sanitize_preview_stem(path), output_ext))
}

fn first_available_tool(candidates: &[&str], version_arg: &str) -> Option<String> {
    candidates.iter().find_map(|candidate| {
        let status = Command::new(candidate)
            .arg(version_arg)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()?;
        status.success().then(|| (*candidate).to_string())
    })
}

fn convert_document_preview(path: &Path) -> Result<PreviewArtifact, String> {
    let tool = first_available_tool(&["soffice", "libreoffice"], "--version").ok_or_else(|| {
        "Install LibreOffice to preview Office and OpenDocument files.".to_string()
    })?;
    let out_dir = preview_cache_dir();
    std::fs::create_dir_all(&out_dir)
        .map_err(|err| format!("Failed to create preview cache directory: {err}"))?;

    let status = Command::new(&tool)
        .args(["--headless", "--convert-to", "pdf", "--outdir"])
        .arg(&out_dir)
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("Failed to run LibreOffice preview conversion: {err}"))?;

    if !status.success() {
        return Err("LibreOffice could not convert this document for preview.".to_string());
    }

    let produced = out_dir.join(format!("{}.pdf", sanitize_preview_stem(path)));
    let office_default = out_dir.join(format!(
        "{}.pdf",
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("preview")
    ));

    let final_path = if office_default.exists() && office_default != produced {
        let _ = std::fs::remove_file(&produced);
        std::fs::rename(&office_default, &produced)
            .map_err(|err| format!("Failed to normalize generated document preview: {err}"))?;
        produced
    } else if produced.exists() {
        produced
    } else {
        return Err("LibreOffice finished without producing a PDF preview.".to_string());
    };

    Ok(PreviewArtifact {
        kind: "pdf".to_string(),
        path: final_path.to_string_lossy().to_string(),
        mime_type: "application/pdf".to_string(),
        tool,
    })
}

fn convert_video_preview(path: &Path) -> Result<PreviewArtifact, String> {
    let tool = first_available_tool(&["ffmpeg"], "-version")
        .ok_or_else(|| "Install FFmpeg to preview this video format.".to_string())?;
    let output = preview_cache_output_path(path, "png");
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create preview cache directory: {err}"))?;
    }

    let status = Command::new(&tool)
        .args(["-y", "-i"])
        .arg(path)
        .args(["-frames:v", "1", "-vf", "thumbnail,scale=1280:-1"])
        .arg(&output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("Failed to run FFmpeg preview generation: {err}"))?;

    if !status.success() || !output.exists() {
        return Err("FFmpeg could not generate a thumbnail for this video.".to_string());
    }

    Ok(PreviewArtifact {
        kind: "image".to_string(),
        path: output.to_string_lossy().to_string(),
        mime_type: "image/png".to_string(),
        tool,
    })
}

fn convert_image_preview(path: &Path) -> Result<PreviewArtifact, String> {
    let tool = first_available_tool(&["magick"], "--version")
        .ok_or_else(|| "Install ImageMagick to preview this image format.".to_string())?;
    let output = preview_cache_output_path(path, "png");
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create preview cache directory: {err}"))?;
    }

    let input = if path_extension_lower(path) == "psd" {
        format!("{}[0]", path.to_string_lossy())
    } else {
        path.to_string_lossy().to_string()
    };
    let status = Command::new(&tool)
        .arg(input)
        .arg(&output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("Failed to run ImageMagick preview conversion: {err}"))?;

    if !status.success() || !output.exists() {
        return Err("ImageMagick could not convert this image for preview.".to_string());
    }

    Ok(PreviewArtifact {
        kind: "image".to_string(),
        path: output.to_string_lossy().to_string(),
        mime_type: "image/png".to_string(),
        tool,
    })
}

fn generate_preview_artifact_impl(path: String) -> Result<PreviewArtifact, String> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err("File not found.".to_string());
    }

    if is_external_document_preview(&path) {
        return convert_document_preview(&path);
    }
    if is_external_video_preview(&path) {
        return convert_video_preview(&path);
    }
    if is_external_image_preview(&path) {
        return convert_image_preview(&path);
    }

    Err("No external preview provider is available for this file type.".to_string())
}

#[tauri::command]
async fn generate_preview_artifact(path: String) -> Result<PreviewArtifact, String> {
    tauri::async_runtime::spawn_blocking(move || generate_preview_artifact_impl(path))
        .await
        .map_err(|err| err.to_string())?
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn is_default_file_manager() -> Result<bool, String> {
    default_file_manager::is_default().map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn is_default_file_manager() -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_default_file_manager() -> Result<(), String> {
    default_file_manager::set_default().map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn set_default_file_manager() -> Result<(), String> {
    Err("Setting the default file manager is only supported on Windows.".into())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn revert_default_file_manager() -> Result<(), String> {
    default_file_manager::revert_default().map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn revert_default_file_manager() -> Result<(), String> {
    Err("Reverting the default file manager is only supported on Windows.".into())
}

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".into())
}

#[tauri::command]
fn get_env_var(name: String) -> Result<String, String> {
    std::env::var(&name).map_err(|_| format!("Environment variable '{}' not found", name))
}

#[cfg(target_os = "windows")]
fn escape_powershell_literal(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "macos")]
fn escape_bash_literal(value: &str) -> String {
    value.replace('\'', "'\\''")
}

fn resolve_update_path(app: &AppHandle, update_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(update_path);
    if path.is_absolute() {
        return Ok(path);
    }
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join(path))
}

#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn apply_update(app: AppHandle, update_path: String) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Auto-update is disabled in dev builds.".to_string());
    }

    let update_file = resolve_update_path(&app, &update_path)?;
    if !update_file.exists() {
        return Err("Update file not found.".to_string());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("Auto-update is not supported on this platform.".to_string())
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let backup_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("explorie-backups");
        std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs();

        let current_exe = std::env::current_exe().map_err(|err| err.to_string())?;
        let pid = std::process::id();

        #[cfg(target_os = "windows")]
        {
            let source = escape_powershell_literal(update_file.to_string_lossy().as_ref());
            let target = escape_powershell_literal(current_exe.to_string_lossy().as_ref());
            let exe_name = current_exe
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("explorie.exe");
            let backup_path = backup_dir.join(format!("{timestamp}-{exe_name}"));
            let backup = escape_powershell_literal(backup_path.to_string_lossy().as_ref());
            let script = format!(
                "$procId = {pid}; $source = '{source}'; $target = '{target}'; $backup = '{backup}'; \
                 while (Get-Process -Id $procId -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 200 }}; \
                 if (Test-Path $target) {{ Copy-Item -Force $target $backup }}; \
                 Move-Item -Force $source $target; Start-Process $target",
                pid = pid,
                source = source,
                target = target,
                backup = backup,
            );

            Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &script,
                ])
                .spawn()
                .map_err(|err| err.to_string())?;
        }

        #[cfg(target_os = "macos")]
        {
            let app_bundle = current_exe
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .ok_or("Could not determine app bundle path")?;

            let source = escape_bash_literal(update_file.to_string_lossy().as_ref());
            let target = escape_bash_literal(app_bundle.to_string_lossy().as_ref());
            let bundle_name = app_bundle
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("explorie.app");
            let backup_path = backup_dir.join(format!("{timestamp}-{bundle_name}"));
            let backup = escape_bash_literal(backup_path.to_string_lossy().as_ref());

            let script = format!(
                r#"pid={}
source='{}'
target='{}'
backup='{}'

while kill -0 $pid 2>/dev/null; do sleep 0.2; done
if [ -e "$target" ]; then
  rm -rf "$backup"
  mv -f "$target" "$backup"
fi
mv -f "$source" "$target"
open "$target"
"#,
                pid, source, target, backup
            );

            Command::new("bash")
                .args(["-c", &script])
                .spawn()
                .map_err(|err| err.to_string())?;
        }

        app.exit(0);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn extract_app_zip(app: AppHandle, zip_path: String) -> Result<String, String> {
    let zip_file = resolve_update_path(&app, &zip_path)?;
    if !zip_file.exists() {
        return Err("Update file not found.".to_string());
    }
    let parent = zip_file.parent().ok_or("Invalid zip path")?;

    let zip_str = zip_file.to_string_lossy();
    let parent_str = parent.to_string_lossy();
    let status = Command::new("ditto")
        .args(["-xk", zip_str.as_ref(), parent_str.as_ref()])
        .status()
        .map_err(|e| e.to_string())?;

    if !status.success() {
        return Err("Failed to extract update".to_string());
    }

    let mut app_path = None;
    let entries = std::fs::read_dir(parent).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let is_app = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("app"))
            .unwrap_or(false);
        if is_app {
            app_path = Some(path);
            break;
        }
    }

    let app_path = app_path.ok_or("Extracted app not found".to_string())?;
    let _ = std::fs::remove_file(zip_file);

    Ok(app_path.to_string_lossy().to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn extract_app_zip(_app: AppHandle, _zip_path: String) -> Result<String, String> {
    Err("This command is only available on macOS".to_string())
}

// --- Archive operations ---

#[derive(Debug, Serialize)]
struct CompressResult {
    output_path: String,
    total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompressProgressPayload {
    operation_id: String,
    processed_bytes: u64,
    total_bytes: u64,
    current_path: String,
}

#[derive(Debug, Serialize)]
struct ExtractResult {
    output_dir: String,
    total_bytes: u64,
}

#[tauri::command]
async fn compress_files(
    window: tauri::Window,
    paths: Vec<String>,
    output_path: String,
    format: String,
    compression_level: String,
    operation_id: String,
) -> Result<CompressResult, String> {
    let window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sources: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        let output = PathBuf::from(&output_path);

        let archive_format = match format.to_lowercase().as_str() {
            "zip" => ArchiveFormat::Zip,
            "tar.gz" | "tgz" => ArchiveFormat::TarGz,
            "tar" => ArchiveFormat::Tar,
            "7z" => ArchiveFormat::SevenZ,
            _ => return Err(format!("Unsupported format: {}", format)),
        };

        let level = match compression_level.to_lowercase().as_str() {
            "none" => CompressionLevel::None,
            "fast" => CompressionLevel::Fast,
            "normal" | "default" => CompressionLevel::Normal,
            "best" | "maximum" => CompressionLevel::Best,
            _ => CompressionLevel::Normal,
        };

        let options = CompressOptions {
            format: archive_format,
            compression_level: level,
            password: None,
        };

        let op_id = operation_id.clone();
        let total_bytes = create_archive_with_progress(
            &sources,
            &output,
            &options,
            |progress: ArchiveProgress| {
                let payload = CompressProgressPayload {
                    operation_id: op_id.clone(),
                    processed_bytes: progress.processed_bytes,
                    total_bytes: progress.total_bytes,
                    current_path: progress.current_path,
                };
                let _ = window.emit("archive:compress-progress", payload);
            },
        )
        .map_err(|e| e.to_string())?;

        Ok(CompressResult {
            output_path,
            total_bytes,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn extract_archive_cmd(
    archive_path: String,
    output_dir: String,
) -> Result<ExtractResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let archive = PathBuf::from(&archive_path);
        let output = PathBuf::from(&output_dir);

        let total_bytes = extract_archive(&archive, &output).map_err(|e| e.to_string())?;

        Ok(ExtractResult {
            output_dir,
            total_bytes,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_archive(archive_path: String) -> Result<ArchiveInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let archive = PathBuf::from(&archive_path);
        list_archive_contents(&archive).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn check_is_archive(path: String) -> bool {
    is_archive(Path::new(&path))
}

fn main() {
    // Initialize structured logging
    // Log level can be controlled via RUST_LOG env var (e.g., RUST_LOG=debug)
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,explorie_core=debug"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_thread_ids(false)
        .with_file(true)
        .with_line_number(true)
        .init();

    info!("Starting explorie desktop application");

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            list_files,
            list_system_locations,
            get_dir_size,
            get_dir_info,
            get_disk_info,
            create_explorie_schema,
            update_custom_fields,
            open_path,
            reveal_in_file_manager,
            quick_look,
            get_finder_tags,
            set_finder_tags,
            get_finder_tag_colors,
            open_with_app,
            get_apps_for_file,
            list_plugins,
            call_plugin,
            get_plugin_methods,
            ffmpeg_preview,
            generate_preview_artifact,
            is_default_file_manager,
            set_default_file_manager,
            revert_default_file_manager,
            get_home_dir,
            get_env_var,
            get_platform,
            get_app_version,
            apply_update,
            extract_app_zip,
            // Archive operations
            compress_files,
            extract_archive_cmd,
            list_archive,
            check_is_archive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_preview_builds_command_with_filters_and_copy_flags() {
        let preview = ffmpeg_preview(
            "input clip.mov".to_string(),
            "out.webm".to_string(),
            Some(true),
            Some(false),
            Some(vec!["scale=1280:-2".to_string(), "fps=30".to_string()]),
            Some(vec!["volume=0.8".to_string()]),
        )
        .expect("preview should build");

        assert_eq!(preview.binary, "ffmpeg");
        assert_eq!(
            preview.args,
            vec![
                "-y",
                "-i",
                "input clip.mov",
                "-vf",
                "scale=1280:-2,fps=30",
                "-c:a",
                "copy",
                "-af",
                "volume=0.8",
                "out.webm"
            ]
        );
    }

    #[test]
    fn ffmpeg_preview_defaults_optional_flags_to_transcode_args() {
        let preview = ffmpeg_preview(
            "input.mp4".to_string(),
            "output.mp4".to_string(),
            None,
            None,
            None,
            None,
        )
        .expect("preview should build");

        assert_eq!(preview.binary, "ffmpeg");
        assert_eq!(preview.args, vec!["-y", "-i", "input.mp4", "output.mp4"]);
    }

    #[test]
    fn preview_artifact_routes_external_document_extensions() {
        for path in [
            "report.doc",
            "report.docx",
            "sheet.xlsx",
            "slides.pptx",
            "document.odt",
            "notes.rtf",
        ] {
            assert!(is_external_document_preview(Path::new(path)));
        }
    }

    #[test]
    fn preview_artifact_routes_external_media_extensions() {
        for path in [
            "legacy.avi",
            "clip.mov",
            "movie.mkv",
            "clip.wmv",
            "capture.flv",
            "camera.m2ts",
        ] {
            assert!(is_external_video_preview(Path::new(path)));
        }

        for path in [
            "photo.heic",
            "photo.heif",
            "scan.tif",
            "scan.tiff",
            "design.psd",
        ] {
            assert!(is_external_image_preview(Path::new(path)));
        }
    }

    #[test]
    fn preview_artifact_cache_paths_are_stable_and_safe() {
        let path = preview_cache_output_path(Path::new("C:/docs/Quarterly Report.docx"), "pdf");
        let path_string = path.to_string_lossy();

        assert!(path_string.contains("explorie-preview-cache"));
        assert!(path_string.ends_with("Quarterly_Report.pdf"));
        assert!(!path_string.contains("Quarterly Report.docx.pdf"));
    }
}
