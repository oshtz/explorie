// Prevents a terminal window from appearing on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod remote_drives;

use explorie_core::archive::{
    ArchiveFormat, ArchiveInfo, ArchiveProgress, CompressOptions, CompressionLevel,
    create_archive_with_progress, extract_archive, is_archive, list_archive_contents,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tracing::info;
use tracing_subscriber::EnvFilter;

use remote_drives::{
    DisconnectResult, RemoteDriveEnvironment, RemoteDriveManager, RemoteDriveProfile,
    RemoteDriveStatus,
};

#[derive(Default)]
struct FileOperationJobs {
    next_id: AtomicU64,
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileOperationEvent {
    job_id: String,
    state: &'static str,
    progress: Option<explorie_core::FileOperationProgress>,
    result: Option<explorie_core::FileOperationResult>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextPreview {
    text: String,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemIntegrationStatus {
    supported: bool,
    enabled: bool,
}

fn launch_directory_from_args(args: impl IntoIterator<Item = OsString>) -> Option<String> {
    args.into_iter()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| path.is_dir())
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_launch_path() -> Option<String> {
    launch_directory_from_args(std::env::args_os())
}

#[cfg(target_os = "windows")]
mod windows_integration {
    use std::io;
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const MENU_KEYS: [(&str, &str); 3] = [
        (r"HKCU\Software\Classes\Directory\shell\Explorie", "%1"),
        (r"HKCU\Software\Classes\Drive\shell\Explorie", "%1"),
        (
            r"HKCU\Software\Classes\Directory\Background\shell\Explorie",
            "%V",
        ),
    ];

    fn reg() -> Command {
        let mut command = Command::new("reg.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    fn run(command: &mut Command) -> io::Result<()> {
        let output = command.output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ))
        }
    }

    fn key_exists(key: &str) -> io::Result<bool> {
        Ok(reg().args(["query", key]).status()?.success())
    }

    fn add_value(key: &str, name: Option<&str>, value: &str) -> io::Result<()> {
        let mut command = reg();
        command.args(["add", key]);
        if let Some(name) = name {
            command.args(["/v", name]);
        } else {
            command.arg("/ve");
        }
        run(command.args(["/d", value, "/f"]))
    }

    fn remove() -> io::Result<()> {
        for (key, _) in MENU_KEYS {
            if key_exists(key)? {
                run(reg().args(["delete", key, "/f"]))?;
            }
        }
        Ok(())
    }

    pub fn enabled() -> io::Result<bool> {
        for (key, _) in MENU_KEYS {
            if !key_exists(key)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn set_enabled(enabled: bool) -> io::Result<()> {
        if !enabled {
            return remove();
        }

        let executable = std::env::current_exe()?;
        let icon = executable.to_string_lossy();
        for (key, path_argument) in MENU_KEYS {
            let result = (|| {
                add_value(key, None, "Open in Explorie")?;
                add_value(key, Some("Icon"), &icon)?;
                add_value(
                    &format!(r"{key}\command"),
                    None,
                    &shell_command(&executable, path_argument),
                )
            })();
            if let Err(error) = result {
                let _ = remove();
                return Err(error);
            }
        }
        Ok(())
    }

    fn shell_command(executable: &Path, path_argument: &str) -> String {
        format!(r#""{}" "{}""#, executable.display(), path_argument)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn shell_command_quotes_executable_and_folder() {
            assert_eq!(
                shell_command(Path::new(r"C:\Program Files\Explorie\explorie.exe"), "%1"),
                r#""C:\Program Files\Explorie\explorie.exe" "%1""#
            );
        }
    }
}

#[tauri::command]
fn get_system_integration_status() -> Result<SystemIntegrationStatus, String> {
    #[cfg(target_os = "windows")]
    {
        windows_integration::enabled()
            .map(|enabled| SystemIntegrationStatus {
                supported: true,
                enabled,
            })
            .map_err(|error| error.to_string())
    }

    #[cfg(not(target_os = "windows"))]
    Ok(SystemIntegrationStatus {
        supported: false,
        enabled: false,
    })
}

#[tauri::command]
fn set_system_integration(enabled: bool) -> Result<SystemIntegrationStatus, String> {
    #[cfg(target_os = "windows")]
    {
        windows_integration::set_enabled(enabled).map_err(|error| error.to_string())?;
        get_system_integration_status()
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("System integration is currently available only on Windows.".to_string())
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

fn find_syncthing_root(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|ancestor| ancestor.join(".stfolder").exists())
        .map(Path::to_path_buf)
}

#[tauri::command]
async fn get_syncthing_root(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        find_syncthing_root(Path::new(&path)).map(|root| root.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
fn get_remote_drive_environment(
    app: AppHandle,
    manager: tauri::State<'_, RemoteDriveManager>,
) -> RemoteDriveEnvironment {
    manager.environment(&app)
}

#[tauri::command]
fn list_rclone_remotes(
    app: AppHandle,
    manager: tauri::State<'_, RemoteDriveManager>,
) -> Result<Vec<String>, String> {
    manager.list_remotes(&app)
}

#[tauri::command]
async fn install_winfsp(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remote_drives::install_winfsp(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn configure_rclone(
    app: AppHandle,
    manager: tauri::State<'_, RemoteDriveManager>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.configure_remotes(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn connect_remote_drive(
    app: AppHandle,
    manager: tauri::State<'_, RemoteDriveManager>,
    profile: RemoteDriveProfile,
) -> Result<RemoteDriveStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.connect(&app, profile))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn disconnect_remote_drive(
    app: AppHandle,
    manager: tauri::State<'_, RemoteDriveManager>,
    id: String,
    force: bool,
) -> Result<DisconnectResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.disconnect(&app, &id, force))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn force_remote_drive_shutdown(
    app: AppHandle,
    manager: tauri::State<'_, RemoteDriveManager>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.disconnect_all(&app);
        app.exit(0);
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_remote_drive_statuses(
    manager: tauri::State<'_, RemoteDriveManager>,
) -> Vec<RemoteDriveStatus> {
    manager.statuses()
}

#[tauri::command]
fn register_remote_drive_helper() -> Result<String, String> {
    remote_drives::register_macos_helper()
}

#[tauri::command]
fn unregister_remote_drive_helper(
    app: AppHandle,
    manager: tauri::State<'_, RemoteDriveManager>,
) -> Result<(), String> {
    manager.disconnect_all(&app);
    remote_drives::unregister_macos_helper()
}

#[tauri::command]
fn open_remote_drive_helper_settings() -> Result<(), String> {
    remote_drives::open_macos_helper_settings()
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
struct PreviewArtifact {
    kind: String,
    path: String,
    mime_type: String,
    tool: String,
}

#[tauri::command]
fn list_system_locations(
    remote_drives: tauri::State<'_, RemoteDriveManager>,
) -> Result<SystemLocations, String> {
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
        .filter(|path| !remote_drives.is_mount_root(Path::new(path)))
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
        let (count, size) = explorie_core::dir_info(Path::new(&path)).map_err(|e| e.to_string())?;
        Ok(DirInfo { count, size })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn emit_file_operation(app: &AppHandle, event: FileOperationEvent) {
    let _ = app.emit("file-operation", event);
}

#[tauri::command]
fn start_file_operation(
    app: AppHandle,
    jobs: tauri::State<'_, FileOperationJobs>,
    remote_drives: tauri::State<'_, RemoteDriveManager>,
    request: explorie_core::FileOperationRequest,
) -> Result<String, String> {
    if request
        .sources
        .iter()
        .any(|source| remote_drives.is_mount_root(source))
    {
        return Err("Refusing to mutate a managed remote-drive root".to_string());
    }
    let job_id = format!(
        "{}-{}",
        std::process::id(),
        jobs.next_id.fetch_add(1, Ordering::Relaxed)
    );
    let cancelled = Arc::new(AtomicBool::new(false));
    jobs.cancellations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(job_id.clone(), Arc::clone(&cancelled));

    let task_job_id = job_id.clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let progress_app = task_app.clone();
        let progress_job_id = task_job_id.clone();
        let operation = tauri::async_runtime::spawn_blocking(move || {
            explorie_core::perform_file_operation(request, &cancelled, |progress| {
                emit_file_operation(
                    &progress_app,
                    FileOperationEvent {
                        job_id: progress_job_id.clone(),
                        state: "running",
                        progress: Some(progress),
                        result: None,
                        error: None,
                    },
                );
            })
        })
        .await;

        task_app
            .state::<FileOperationJobs>()
            .cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&task_job_id);

        let event = match operation {
            Ok(Ok(result)) => FileOperationEvent {
                job_id: task_job_id,
                state: "completed",
                progress: None,
                result: Some(result),
                error: None,
            },
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::Interrupted => {
                FileOperationEvent {
                    job_id: task_job_id,
                    state: "cancelled",
                    progress: None,
                    result: None,
                    error: None,
                }
            }
            Ok(Err(error)) => FileOperationEvent {
                job_id: task_job_id,
                state: "failed",
                progress: None,
                result: None,
                error: Some(error.to_string()),
            },
            Err(error) => FileOperationEvent {
                job_id: task_job_id,
                state: "failed",
                progress: None,
                result: None,
                error: Some(error.to_string()),
            },
        };
        emit_file_operation(&task_app, event);
    });

    Ok(job_id)
}

#[tauri::command]
fn cancel_file_operation(jobs: tauri::State<'_, FileOperationJobs>, job_id: String) -> bool {
    let jobs = jobs
        .cancellations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(cancelled) = jobs.get(&job_id) {
        cancelled.store(true, Ordering::Relaxed);
        true
    } else {
        false
    }
}

fn read_text_preview_impl(path: &Path, max_bytes: u64) -> Result<TextPreview, String> {
    const MAX_TEXT_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;
    let limit = max_bytes.min(MAX_TEXT_PREVIEW_BYTES);
    let mut bytes = Vec::with_capacity(limit.min(128 * 1024) as usize);
    File::open(path)
        .map_err(|error| error.to_string())?
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let truncated = bytes.len() as u64 > limit;
    bytes.truncate(limit as usize);
    Ok(TextPreview {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

#[tauri::command]
async fn read_text_preview(path: String, max_bytes: u64) -> Result<TextPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_text_preview_impl(Path::new(&path), max_bytes)
    })
    .await
    .map_err(|error| error.to_string())?
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

fn validate_file_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("File name cannot be empty".to_string());
    }
    if name == "." || name == ".." {
        return Err("File name cannot be . or ..".to_string());
    }
    if name.contains(['/', '\\']) {
        return Err("File name cannot contain path separators".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("File name cannot contain control characters".to_string());
    }

    #[cfg(windows)]
    {
        if name.contains(['<', '>', ':', '"', '|', '?', '*']) {
            return Err("File name contains invalid Windows characters".to_string());
        }
        if name.ends_with(['.', ' ']) {
            return Err("File name cannot end with a period or space".to_string());
        }
        let base = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || base
                .strip_prefix("COM")
                .or_else(|| base.strip_prefix("LPT"))
                .is_some_and(|number| {
                    matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                });
        if reserved {
            return Err("File name is reserved on Windows".to_string());
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

fn validate_no_link_ancestors(path: &Path) -> Result<(), String> {
    let mut ancestors: Vec<&Path> = path.ancestors().collect();
    ancestors.reverse();
    for ancestor in ancestors {
        let metadata = fs::symlink_metadata(ancestor).map_err(|error| error.to_string())?;
        if metadata_is_link(&metadata) {
            return Err(format!(
                "Refusing to traverse a symbolic link or junction: {}",
                ancestor.display()
            ));
        }
    }
    Ok(())
}

fn validate_real_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Directory path must be absolute".to_string());
    }
    validate_no_link_ancestors(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata_is_link(&metadata) || !metadata.is_dir() {
        return Err("Destination must be a real directory".to_string());
    }
    Ok(())
}

fn mount_check_path(path: &Path, canonical: io::Result<PathBuf>) -> Result<PathBuf, String> {
    match canonical {
        Ok(path) => Ok(path),
        #[cfg(windows)]
        Err(error) if error.raw_os_error() == Some(1005) => Ok(path.to_path_buf()),
        Err(error) => Err(error.to_string()),
    }
}

fn ensure_not_mount_root(path: &Path) -> Result<(), String> {
    use sysinfo::Disks;

    let canonical = mount_check_path(path, fs::canonicalize(path))?;
    if canonical.parent().is_none() {
        return Err("Refusing to mutate a filesystem root".to_string());
    }
    let disks = Disks::new_with_refreshed_list();
    if disks.iter().any(|disk| {
        mount_check_path(disk.mount_point(), fs::canonicalize(disk.mount_point()))
            .is_ok_and(|mount| mount == canonical)
    }) {
        return Err("Refusing to mutate a mounted volume root".to_string());
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
) -> Result<PathBuf, String> {
    for number in 1..=9_999 {
        let candidate = parent.join(suffixed_name(base_name, number, preserve_extension));
        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        match create(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not find a unique file name".to_string())
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

#[tauri::command]
fn rename_path(
    remote_drives: tauri::State<'_, RemoteDriveManager>,
    source_path: String,
    new_base_name: String,
) -> Result<String, String> {
    if remote_drives.is_mount_root(Path::new(&source_path)) {
        return Err("Refusing to rename a managed remote-drive root".to_string());
    }
    rename_path_impl(source_path, new_base_name)
}

fn rename_path_impl(source_path: String, new_base_name: String) -> Result<String, String> {
    let source = PathBuf::from(source_path);
    if !source.is_absolute() {
        return Err("Source path must be absolute".to_string());
    }
    let metadata = fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
    if !metadata_is_link(&metadata) {
        ensure_not_mount_root(&source)?;
    }
    if !metadata_is_link(&metadata) && !metadata.is_file() && !metadata.is_dir() {
        return Err("Unsupported filesystem entry".to_string());
    }
    let parent = source
        .parent()
        .ok_or_else(|| "Cannot rename a filesystem root".to_string())?;
    validate_real_directory(parent)?;
    let name = validate_file_name(&new_base_name)?;
    let destination = create_unique_path(parent, &name, true, |candidate| {
        explorie_core::rename_noreplace(&source, candidate)
    })?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn create_folder(dir_path: String, base_name: String) -> Result<String, String> {
    let directory = PathBuf::from(dir_path);
    validate_real_directory(&directory)?;
    let name = validate_file_name(&base_name)?;
    let path = create_unique_path(&directory, &name, false, |candidate| {
        fs::create_dir(candidate)
    })?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn create_note(dir_path: String, base_name: String) -> Result<String, String> {
    let directory = PathBuf::from(dir_path);
    validate_real_directory(&directory)?;
    let name = validate_file_name(&ensure_extension(&base_name, ".md"))?;
    let path = create_unique_path(&directory, &name, true, |candidate| {
        write_new_text_file(candidate, b"# New Note\n")
    })?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn create_website_link(dir_path: String, base_name: String, url: String) -> Result<String, String> {
    let directory = PathBuf::from(dir_path);
    validate_real_directory(&directory)?;
    let name = validate_file_name(&ensure_extension(&base_name, ".url"))?;
    let url = url.trim();
    if url.chars().any(char::is_control) {
        return Err("Website URL cannot contain control characters".to_string());
    }
    let normalized = url.to_ascii_lowercase();
    if !normalized.starts_with("https://") && !normalized.starts_with("http://") {
        return Err("Website URL must use http or https".to_string());
    }
    let contents = format!("[InternetShortcut]\nURL={url}\n");
    let path = create_unique_path(&directory, &name, true, |candidate| {
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

fn delete_path_permanently_impl(path: &Path, recursive: bool) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Delete path must be absolute".to_string());
    }
    if let Some(parent) = path.parent() {
        validate_no_link_ancestors(parent)?;
    }
    let root_metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    let root_kind = delete_entry_kind(&root_metadata).map_err(|error| error.to_string())?;
    if root_kind != DeleteEntryKind::Link {
        ensure_not_mount_root(path)?;
    }
    if root_kind != DeleteEntryKind::Directory || !recursive {
        return remove_planned_entry(path, root_kind).map_err(|error| error.to_string());
    }

    // Preflight the complete tree before the first irreversible deletion.
    let mut entries = Vec::new();
    collect_delete_entries(path, &root_metadata, &mut entries)
        .map_err(|error| error.to_string())?;
    for (entry, kind) in entries.into_iter().rev() {
        remove_planned_entry(&entry, kind).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn delete_path_permanently(
    remote_drives: tauri::State<'_, RemoteDriveManager>,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    if remote_drives.is_mount_root(Path::new(&path)) {
        return Err("Refusing to delete a managed remote-drive root".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        delete_path_permanently_impl(Path::new(&path), recursive)
    })
    .await
    .map_err(|error| error.to_string())?
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

#[cfg(target_os = "windows")]
#[tauri::command]
fn open_with_app(path: String, _app_name: String) -> Result<(), String> {
    Command::new("rundll32.exe")
        .args(["shell32.dll,OpenAs_RunDLL", &path])
        .spawn()
        .map_err(|err| format!("Failed to open Windows Open with: {err}"))?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
fn open_with_app(_path: String, _app_name: String) -> Result<(), String> {
    Err("Open With is unavailable on this platform.".to_string())
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

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_apps_for_file(_path: String) -> Result<Vec<AppInfo>, String> {
    Ok(vec![AppInfo {
        name: "Choose another app…".to_string(),
        path: String::new(),
        bundle_id: None,
    }])
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
fn get_apps_for_file(_path: String) -> Result<Vec<AppInfo>, String> {
    Ok(Vec::new())
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

#[cfg(target_os = "windows")]
fn file_icon_cache_path(path: &Path) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};

    let metadata = path
        .metadata()
        .map_err(|err| format!("Failed to inspect executable: {err}"))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy()
        .to_ascii_lowercase()
        .hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    metadata.modified().ok().hash(&mut hasher);
    Ok(preview_cache_dir().join(format!("file-icon-{:016x}.png", hasher.finish())))
}

#[cfg(target_os = "windows")]
fn get_file_icon_impl(path: String) -> Result<Option<String>, String> {
    let path = PathBuf::from(path);
    if !path.is_file() || !matches!(path_extension_lower(&path).as_str(), "exe" | "lnk") {
        return Ok(None);
    }

    let output = file_icon_cache_path(&path)?;
    if output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
        return Ok(Some(output.to_string_lossy().to_string()));
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create preview cache directory: {err}"))?;
    }

    // Keep user-controlled paths out of the command string; PowerShell reads them from env vars.
    let script = r#"Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:EXPLORIE_ICON_INPUT)
if ($null -eq $icon) { exit 2 }
try {
  $bitmap = $icon.ToBitmap()
  try { $bitmap.Save($env:EXPLORIE_ICON_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png) }
  finally { $bitmap.Dispose() }
} finally { $icon.Dispose() }"#;
    let status = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .env("EXPLORIE_ICON_INPUT", &path)
        .env("EXPLORIE_ICON_OUTPUT", &output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("Failed to extract file icon: {err}"))?;

    if status.success() && output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
        Ok(Some(output.to_string_lossy().to_string()))
    } else {
        let _ = std::fs::remove_file(output);
        Ok(None)
    }
}

#[cfg(not(target_os = "windows"))]
fn get_file_icon_impl(_path: String) -> Result<Option<String>, String> {
    Ok(None)
}

#[tauri::command]
async fn get_file_icon(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || get_file_icon_impl(path))
        .await
        .map_err(|err| err.to_string())?
}

fn thumbnail_cache_path(path: &Path, max_size: u32) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};

    let metadata = path
        .metadata()
        .map_err(|err| format!("Failed to inspect file: {err}"))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    metadata.modified().ok().hash(&mut hasher);
    max_size.hash(&mut hasher);
    Ok(preview_cache_dir().join(format!("thumbnail-{:016x}.png", hasher.finish())))
}

fn prune_thumbnail_cache() {
    const MAX_ENTRIES: usize = 256;
    const MAX_BYTES: u64 = 128 * 1024 * 1024;

    let Ok(entries) = std::fs::read_dir(preview_cache_dir()) else {
        return;
    };
    let mut cached: Vec<(PathBuf, std::time::SystemTime, u64)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            if !name.to_string_lossy().starts_with("thumbnail-") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((
                entry.path(),
                metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                metadata.len(),
            ))
        })
        .collect();
    cached.sort_by_key(|(_, modified, _)| *modified);
    let mut total_bytes = cached.iter().map(|(_, _, size)| *size).sum::<u64>();
    while cached.len() > MAX_ENTRIES || total_bytes > MAX_BYTES {
        let (path, _, size) = cached.remove(0);
        if std::fs::remove_file(path).is_ok() {
            total_bytes = total_bytes.saturating_sub(size);
        }
    }
}

#[cfg(target_os = "windows")]
fn generate_native_thumbnail(input: &Path, output: &Path, max_size: u32) -> Result<(), String> {
    let script = r#"Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($env:EXPLORIE_THUMB_INPUT)
try {
  $scale = [Math]::Min(1.0, [Math]::Min($env:EXPLORIE_THUMB_SIZE / $image.Width, $env:EXPLORIE_THUMB_SIZE / $image.Height))
  $width = [Math]::Max(1, [int]($image.Width * $scale))
  $height = [Math]::Max(1, [int]($image.Height * $scale))
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($image, 0, 0, $width, $height)
    } finally { $graphics.Dispose() }
    $bitmap.Save($env:EXPLORIE_THUMB_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bitmap.Dispose() }
} finally { $image.Dispose() }"#;
    let status = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .env("EXPLORIE_THUMB_INPUT", input)
        .env("EXPLORIE_THUMB_OUTPUT", output)
        .env("EXPLORIE_THUMB_SIZE", max_size.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("Failed to start native thumbnailer: {err}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "Windows could not decode this image".to_string())
}

#[cfg(target_os = "macos")]
fn generate_native_thumbnail(input: &Path, output: &Path, max_size: u32) -> Result<(), String> {
    let status = Command::new("sips")
        .args(["-s", "format", "png", "-Z", &max_size.to_string()])
        .arg(input)
        .arg("--out")
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("Failed to start native thumbnailer: {err}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "macOS could not decode this image".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn generate_native_thumbnail(_input: &Path, _output: &Path, _max_size: u32) -> Result<(), String> {
    Err("Native thumbnails are unavailable on this platform".to_string())
}

fn is_video_thumbnail(path: &Path) -> bool {
    matches!(
        path_extension_lower(path).as_str(),
        "mp4"
            | "webm"
            | "m4v"
            | "mov"
            | "avi"
            | "mkv"
            | "wmv"
            | "flv"
            | "m2ts"
            | "mts"
            | "mpeg"
            | "mpg"
            | "3gp"
    )
}

fn generate_video_thumbnail(input: &Path, output: &Path, max_size: u32) -> Result<(), String> {
    let tool = first_available_tool(&["ffmpeg"], "-version")
        .ok_or_else(|| "Install FFmpeg to generate video thumbnails.".to_string())?;
    let filter =
        format!("thumbnail,scale={max_size}:{max_size}:force_original_aspect_ratio=decrease");
    let status = Command::new(tool)
        .args(["-y", "-i"])
        .arg(input)
        .args(["-frames:v", "1", "-vf", &filter])
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("Failed to run FFmpeg thumbnail generation: {err}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "FFmpeg could not generate a video thumbnail".to_string())
}

fn get_file_thumbnail_impl(path: String, max_size: u32) -> Result<Option<String>, String> {
    let input = PathBuf::from(path);
    if !input.is_file() {
        return Ok(None);
    }
    let extension = path_extension_lower(&input);
    let is_image = matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "tif" | "tiff"
    );
    if !is_image && !is_video_thumbnail(&input) {
        return Ok(None);
    }
    let max_size = max_size.clamp(64, 512);
    let output = thumbnail_cache_path(&input, max_size)?;
    if output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
        return Ok(Some(output.to_string_lossy().to_string()));
    }
    std::fs::create_dir_all(preview_cache_dir())
        .map_err(|err| format!("Failed to create thumbnail cache: {err}"))?;
    let result = if is_image {
        generate_native_thumbnail(&input, &output, max_size)
    } else {
        generate_video_thumbnail(&input, &output, max_size)
    };
    if let Err(error) = result {
        let _ = std::fs::remove_file(&output);
        return Err(error);
    }
    if !output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
        return Err("Native thumbnailer produced an empty image".to_string());
    }
    prune_thumbnail_cache();
    Ok(Some(output.to_string_lossy().to_string()))
}

#[tauri::command]
async fn get_file_thumbnail(path: String, max_size: u32) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || get_file_thumbnail_impl(path, max_size))
        .await
        .map_err(|err| err.to_string())?
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

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".into())
}

#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
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

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = launch_directory_from_args(args.into_iter().map(OsString::from)) {
                let _ = app.emit("open-path", path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(FileOperationJobs::default())
        .manage(RemoteDriveManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            list_files,
            get_syncthing_root,
            list_system_locations,
            get_launch_path,
            get_system_integration_status,
            set_system_integration,
            get_remote_drive_environment,
            list_rclone_remotes,
            install_winfsp,
            configure_rclone,
            connect_remote_drive,
            disconnect_remote_drive,
            force_remote_drive_shutdown,
            get_remote_drive_statuses,
            register_remote_drive_helper,
            unregister_remote_drive_helper,
            open_remote_drive_helper_settings,
            get_dir_size,
            get_dir_info,
            get_disk_info,
            start_file_operation,
            cancel_file_operation,
            read_text_preview,
            rename_path,
            create_folder,
            create_note,
            create_website_link,
            delete_path_permanently,
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
            get_file_icon,
            get_file_thumbnail,
            generate_preview_artifact,
            get_home_dir,
            get_platform,
            get_app_version,
            // Archive operations
            compress_files,
            extract_archive_cmd,
            list_archive,
            check_is_archive,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event
            && !app_handle
                .state::<RemoteDriveManager>()
                .disconnect_all_if_clean(app_handle)
        {
            api.prevent_exit();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "explorie-mutation-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn launch_path_uses_only_an_existing_directory_argument() {
        let directory = TestDir::new();
        let args = [
            OsString::from("explorie.exe"),
            OsString::from("missing-folder"),
            directory.0.clone().into_os_string(),
        ];

        assert_eq!(
            launch_directory_from_args(args),
            Some(directory.0.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn syncthing_root_is_found_from_a_descendant() {
        let directory = TestDir::new();
        let child = directory.0.join("nested").join("folder");
        fs::create_dir_all(&child).unwrap();
        fs::create_dir(directory.0.join(".stfolder")).unwrap();

        assert_eq!(find_syncthing_root(&child), Some(directory.0.clone()));
        assert_eq!(find_syncthing_root(directory.0.parent().unwrap()), None);
    }

    #[test]
    fn text_preview_reads_only_the_requested_prefix() {
        let path = std::env::temp_dir().join(format!(
            "explorie-text-preview-test-{}.txt",
            std::process::id()
        ));
        std::fs::write(&path, b"abcdef").unwrap();

        let preview = read_text_preview_impl(&path, 4).unwrap();
        let _ = std::fs::remove_file(path);

        assert_eq!(preview.text, "abcd");
        assert!(preview.truncated);
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

    #[test]
    fn native_file_icons_ignore_unsupported_files() {
        assert_eq!(get_file_icon_impl("notes.txt".to_string()).unwrap(), None);
    }

    #[test]
    fn native_thumbnail_cache_keys_include_source_metadata_and_bounds() {
        let temp = TestDir::new();
        let image = temp.0.join("photo.jpg");
        fs::write(&image, b"first").unwrap();
        let small = thumbnail_cache_path(&image, 128).unwrap();
        let large = thumbnail_cache_path(&image, 256).unwrap();
        assert_ne!(small, large);
        assert!(
            small
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("thumbnail-")
        );

        fs::write(&image, b"changed image contents").unwrap();
        assert_ne!(small, thumbnail_cache_path(&image, 128).unwrap());
    }

    #[test]
    fn grid_thumbnail_routes_video_extensions() {
        for path in ["clip.mp4", "clip.webm", "clip.mov", "clip.avi", "clip.mkv"] {
            assert!(is_video_thumbnail(Path::new(path)));
        }
        assert!(!is_video_thumbnail(Path::new("photo.jpg")));
    }

    #[test]
    fn native_mutations_validate_names_and_never_overwrite() {
        let temp = TestDir::new();
        let existing = temp.0.join("report.txt");
        let source = temp.0.join("draft.txt");
        fs::write(&existing, b"existing").unwrap();
        fs::write(&source, b"draft").unwrap();

        let renamed = PathBuf::from(
            rename_path_impl(
                source.to_string_lossy().into_owned(),
                "report.txt".to_string(),
            )
            .unwrap(),
        );
        assert_eq!(renamed.file_name().unwrap(), "report (2).txt");
        assert_eq!(fs::read(&existing).unwrap(), b"existing");
        assert_eq!(fs::read(&renamed).unwrap(), b"draft");

        let folder =
            create_folder(temp.0.to_string_lossy().into_owned(), "Project".to_string()).unwrap();
        assert!(Path::new(&folder).is_dir());
        let note = create_note(
            temp.0.to_string_lossy().into_owned(),
            "Meeting Notes".to_string(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(note).unwrap(), "# New Note\n");
        let link = create_website_link(
            temp.0.to_string_lossy().into_owned(),
            "Explorie".to_string(),
            "https://example.com".to_string(),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(link).unwrap(),
            "[InternetShortcut]\nURL=https://example.com\n"
        );

        assert!(validate_file_name("../escape").is_err());
        assert!(
            create_website_link(
                temp.0.to_string_lossy().into_owned(),
                "unsafe".to_string(),
                "https://example.com\nIconFile=bad".to_string(),
            )
            .is_err()
        );
        assert!(
            create_website_link(
                temp.0.to_string_lossy().into_owned(),
                "unsafe".to_string(),
                "javascript:alert(1)".to_string(),
            )
            .is_err()
        );
    }

    #[test]
    fn filesystem_roots_are_rejected() {
        #[cfg(windows)]
        let root = Path::new("C:\\");
        #[cfg(unix)]
        let root = Path::new("/");

        assert!(ensure_not_mount_root(root).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn unrecognized_windows_volumes_use_lexical_paths_for_mount_checks() {
        let path = Path::new(r"R:\file.txt");
        assert_eq!(
            mount_check_path(path, Err(io::Error::from_raw_os_error(1005))).unwrap(),
            path
        );
        assert!(mount_check_path(path, Err(io::Error::from_raw_os_error(5))).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn permanent_delete_unlinks_symlinks_without_following_them() {
        use std::os::unix::fs::symlink;

        let temp = TestDir::new();
        let outside = temp.0.join("outside");
        let source = temp.0.join("source");
        fs::create_dir(&outside).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(outside.join("keep.txt"), b"keep").unwrap();
        symlink(&outside, source.join("link")).unwrap();
        let alias = temp.0.join("outside-alias");
        symlink(&outside, &alias).unwrap();

        assert!(delete_path_permanently_impl(&alias.join("keep.txt"), false).is_err());

        delete_path_permanently_impl(&source, true).unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"keep");
    }
}
