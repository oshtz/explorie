// Prevents a terminal window from appearing on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use explorie_native_services::archive::{ArchiveFormat, CompressionLevel};
use explorie_native_services::integration::SystemIntegrationStatus;
use explorie_native_services::listing::ListRequest;
use explorie_native_services::remote_drives::{
    DisconnectResult, RemoteDriveEnvironment, RemoteDriveProfile, RemoteDriveState,
    RemoteDriveStatus,
};
use explorie_native_services::{
    BlockingTask, FileOperationEvent, FileOperationState, NativeServices, ResourcePaths,
    ServiceError, ServiceEvent, WatcherEvent,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::thread;
use tauri::{AppHandle, Emitter, Manager};
use tracing::info;
use tracing_subscriber::EnvFilter;

async fn wait<T>(task: BlockingTask<T>) -> Result<T, String> {
    task.await.map_err(|error| error.to_string())
}

fn default_resources() -> ResourcePaths {
    let cache = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("explorie");
    let resource_dir = std::env::var_os("EXPLORIE_RESOURCE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(|path| path.join("resources")))
        });
    ResourcePaths::new(cache)
        .with_resource_dir(resource_dir)
        .with_manifest_dir(env!("CARGO_MANIFEST_DIR"))
        .with_app_version(env!("CARGO_PKG_VERSION"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyFileOperationEvent {
    job_id: String,
    state: &'static str,
    progress: Option<explorie_core::FileOperationProgress>,
    result: Option<explorie_core::FileOperationResult>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRemoteDriveEnvironment {
    platform: String,
    rclone_available: bool,
    rclone_version: Option<String>,
    winfsp_available: Option<bool>,
    helper_status: Option<String>,
    occupied_mount_targets: Vec<String>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRemoteDriveStatus {
    id: String,
    state: &'static str,
    mount_path: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRemoteDriveExitBlocker {
    pending_uploads: u64,
    errored_files: u64,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyArchiveProgress {
    operation_id: String,
    processed_bytes: u64,
    total_bytes: u64,
    current_path: String,
}

fn error_text(error: Option<ServiceError>) -> Option<String> {
    error.map(|error| error.message)
}

fn remote_status(status: RemoteDriveStatus) -> LegacyRemoteDriveStatus {
    LegacyRemoteDriveStatus {
        id: status.id,
        state: remote_state_name(status.state),
        mount_path: status
            .mount_path
            .map(|path| path.to_string_lossy().into_owned()),
        error: error_text(status.error),
    }
}

fn remote_environment(environment: RemoteDriveEnvironment) -> LegacyRemoteDriveEnvironment {
    LegacyRemoteDriveEnvironment {
        platform: environment.platform,
        rclone_available: environment.rclone_available,
        rclone_version: environment.rclone_version,
        winfsp_available: environment.winfsp_available,
        helper_status: environment.helper_status,
        occupied_mount_targets: environment.occupied_mount_targets,
        error: error_text(environment.error),
    }
}

fn remote_state_name(state: RemoteDriveState) -> &'static str {
    match state {
        RemoteDriveState::ApprovalRequired => "approval-required",
        RemoteDriveState::Connecting => "connecting",
        RemoteDriveState::Connected => "connected",
        RemoteDriveState::Disconnecting => "disconnecting",
        RemoteDriveState::Disconnected => "disconnected",
        RemoteDriveState::Error => "error",
    }
}

fn forward_service_events(app: AppHandle, services: NativeServices) {
    let receiver = services.subscribe();
    thread::spawn(move || {
        while let Ok(event) = receiver.recv() {
            match event {
                ServiceEvent::FileOperation(event) => {
                    let _ = app.emit("file-operation", legacy_file_operation(event));
                }
                ServiceEvent::ArchiveProgress(progress) => {
                    let _ = app.emit(
                        "archive:compress-progress",
                        LegacyArchiveProgress {
                            operation_id: progress.operation_id,
                            processed_bytes: progress.processed_bytes,
                            total_bytes: progress.total_bytes,
                            current_path: progress.current_path,
                        },
                    );
                }
                ServiceEvent::RemoteDriveStatus(status) => {
                    let _ = app.emit("remote-drive-status", remote_status(status));
                }
                ServiceEvent::RemoteDriveExitBlocked(blocker) => {
                    let _ = app.emit(
                        "remote-drive-exit-blocked",
                        LegacyRemoteDriveExitBlocker {
                            pending_uploads: blocker.pending_uploads,
                            errored_files: blocker.errored_files,
                            error: error_text(blocker.error),
                        },
                    );
                }
                ServiceEvent::MutationIdle => {
                    let app = app.clone();
                    let remotes = services.remotes.clone();
                    thread::spawn(move || {
                        if remotes.disconnect_all_if_clean() {
                            app.exit(0);
                        }
                    });
                }
                ServiceEvent::HelperStatus(status) => {
                    let _ = app.emit("helper-status", status);
                }
                ServiceEvent::Watcher(WatcherEvent {
                    registration_id,
                    state,
                    paths,
                    error,
                }) => {
                    let _ = app.emit(
                        "filesystem-change",
                        serde_json::json!({
                            "registrationId": registration_id,
                            "state": format!("{state:?}").to_ascii_lowercase(),
                            "paths": paths,
                            "error": error_text(error),
                        }),
                    );
                }
            }
        }
    });
}

fn legacy_file_operation(event: FileOperationEvent) -> LegacyFileOperationEvent {
    LegacyFileOperationEvent {
        job_id: event.job_id,
        state: match event.state {
            FileOperationState::Running => "running",
            FileOperationState::Completed => "completed",
            FileOperationState::Cancelled => "cancelled",
            FileOperationState::Failed => "failed",
        },
        progress: event.progress,
        result: event.result,
        error: error_text(event.error),
    }
}

#[tauri::command]
async fn get_launch_path(
    services: tauri::State<'_, NativeServices>,
) -> Result<Option<String>, String> {
    let args = std::env::args_os().collect::<Vec<_>>();
    wait(services.listing.launch_path(args))
        .await
        .map(|path| path.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn get_system_integration_status(
    services: tauri::State<'_, NativeServices>,
) -> Result<SystemIntegrationStatus, String> {
    wait(services.integration.status()).await
}

#[tauri::command]
async fn set_system_integration(
    services: tauri::State<'_, NativeServices>,
    enabled: bool,
) -> Result<SystemIntegrationStatus, String> {
    wait(services.integration.set_status(enabled)).await
}

#[tauri::command]
async fn list_files(
    services: tauri::State<'_, NativeServices>,
    path: String,
    calc_dir_size: Option<bool>,
) -> Result<Vec<explorie_core::FileEntry>, String> {
    wait(services.listing.list(ListRequest {
        path: PathBuf::from(path),
        calc_dir_size: calc_dir_size.unwrap_or(false),
    }))
    .await
}

#[tauri::command]
async fn get_syncthing_root(
    services: tauri::State<'_, NativeServices>,
    path: String,
) -> Result<Option<String>, String> {
    services
        .listing
        .syncthing_root(PathBuf::from(path))
        .await
        .map(|path| path.map(|path| path.to_string_lossy().into_owned()))
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_remote_drive_environment(
    services: tauri::State<'_, NativeServices>,
) -> Result<LegacyRemoteDriveEnvironment, String> {
    wait(services.remotes.environment())
        .await
        .map(remote_environment)
}

#[tauri::command]
async fn list_rclone_remotes(
    services: tauri::State<'_, NativeServices>,
) -> Result<Vec<String>, String> {
    wait(services.remotes.list_remotes()).await
}

#[tauri::command]
async fn install_winfsp(services: tauri::State<'_, NativeServices>) -> Result<(), String> {
    wait(services.remotes.install_winfsp()).await
}

#[tauri::command]
async fn configure_rclone(services: tauri::State<'_, NativeServices>) -> Result<(), String> {
    wait(services.remotes.configure()).await
}

#[tauri::command]
async fn connect_remote_drive(
    services: tauri::State<'_, NativeServices>,
    profile: RemoteDriveProfile,
) -> Result<LegacyRemoteDriveStatus, String> {
    wait(services.remotes.connect(profile))
        .await
        .map(remote_status)
}

#[tauri::command]
async fn disconnect_remote_drive(
    services: tauri::State<'_, NativeServices>,
    id: String,
    force: bool,
) -> Result<LegacyDisconnectResult, String> {
    wait(services.remotes.disconnect(id, force))
        .await
        .map(legacy_disconnect)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDisconnectResult {
    status: LegacyRemoteDriveStatus,
    pending_uploads: u64,
    errored_files: u64,
    blocked: bool,
}

fn legacy_disconnect(result: DisconnectResult) -> LegacyDisconnectResult {
    LegacyDisconnectResult {
        status: remote_status(result.status),
        pending_uploads: result.pending_uploads,
        errored_files: result.errored_files,
        blocked: result.blocked,
    }
}

#[tauri::command]
async fn force_remote_drive_shutdown(
    app: AppHandle,
    services: tauri::State<'_, NativeServices>,
) -> Result<(), String> {
    wait(services.remotes.disconnect_all()).await?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn get_remote_drive_statuses(
    services: tauri::State<'_, NativeServices>,
) -> Result<Vec<LegacyRemoteDriveStatus>, String> {
    wait(services.remotes.statuses_task())
        .await
        .map(|statuses| statuses.into_iter().map(remote_status).collect())
}

#[tauri::command]
async fn register_remote_drive_helper(
    services: tauri::State<'_, NativeServices>,
) -> Result<String, String> {
    wait(services.remotes.register_helper()).await
}

#[tauri::command]
async fn unregister_remote_drive_helper(
    services: tauri::State<'_, NativeServices>,
) -> Result<(), String> {
    wait(services.remotes.unregister_helper()).await
}

#[tauri::command]
async fn open_remote_drive_helper_settings(
    services: tauri::State<'_, NativeServices>,
) -> Result<(), String> {
    wait(services.remotes.open_helper_settings()).await
}

#[tauri::command]
async fn create_explorie_schema(
    services: tauri::State<'_, NativeServices>,
    dir_path: String,
    fields: HashMap<String, HashMap<String, Value>>,
) -> Result<(), String> {
    wait(
        services
            .metadata
            .create_schema(PathBuf::from(dir_path), fields),
    )
    .await
}

#[tauri::command]
async fn update_custom_fields(
    services: tauri::State<'_, NativeServices>,
    dir_path: String,
    file_name: String,
    custom_fields: HashMap<String, Value>,
) -> Result<(), String> {
    wait(
        services
            .metadata
            .update_fields(PathBuf::from(dir_path), file_name, custom_fields),
    )
    .await
}

#[tauri::command]
async fn list_system_locations(
    services: tauri::State<'_, NativeServices>,
) -> Result<explorie_native_services::SystemLocations, String> {
    wait(services.listing.system_locations()).await
}

#[tauri::command]
async fn get_disk_info(
    services: tauri::State<'_, NativeServices>,
    path: String,
) -> Result<explorie_native_services::DiskInfo, String> {
    wait(services.listing.disk_info(PathBuf::from(path))).await
}

#[tauri::command]
async fn get_dir_size(
    services: tauri::State<'_, NativeServices>,
    path: String,
) -> Result<u64, String> {
    wait(services.listing.folder_size(PathBuf::from(path))).await
}

#[tauri::command]
async fn get_dir_info(
    services: tauri::State<'_, NativeServices>,
    path: String,
) -> Result<explorie_native_services::DirInfo, String> {
    wait(services.listing.dir_info(PathBuf::from(path))).await
}

#[tauri::command]
fn start_file_operation(
    services: tauri::State<'_, NativeServices>,
    request: explorie_core::FileOperationRequest,
) -> Result<String, String> {
    services
        .mutations
        .start_file_operation(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_file_operation(services: tauri::State<'_, NativeServices>, job_id: String) -> bool {
    services.mutations.cancel_file_operation(&job_id)
}

#[tauri::command]
async fn watch_paths(
    services: tauri::State<'_, NativeServices>,
    paths: Vec<String>,
) -> Result<u64, String> {
    wait(
        services
            .watcher
            .watch_paths_task(paths.into_iter().map(PathBuf::from).collect()),
    )
    .await
}

#[tauri::command]
async fn unwatch_paths(
    services: tauri::State<'_, NativeServices>,
    registration_id: u64,
) -> Result<bool, String> {
    wait(services.watcher.unwatch_task(registration_id)).await
}

#[tauri::command]
async fn read_text_preview(
    services: tauri::State<'_, NativeServices>,
    path: String,
    max_bytes: u64,
) -> Result<explorie_native_services::TextPreview, String> {
    wait(services.previews.read_text(PathBuf::from(path), max_bytes)).await
}

#[tauri::command]
async fn rename_path(
    services: tauri::State<'_, NativeServices>,
    source_path: String,
    new_base_name: String,
) -> Result<String, String> {
    wait(
        services
            .mutations
            .rename_path(PathBuf::from(source_path), new_base_name),
    )
    .await
}

#[tauri::command]
async fn create_folder(
    services: tauri::State<'_, NativeServices>,
    dir_path: String,
    base_name: String,
) -> Result<String, String> {
    wait(
        services
            .mutations
            .create_folder(PathBuf::from(dir_path), base_name),
    )
    .await
}

#[tauri::command]
async fn create_note(
    services: tauri::State<'_, NativeServices>,
    dir_path: String,
    base_name: String,
) -> Result<String, String> {
    wait(
        services
            .mutations
            .create_note(PathBuf::from(dir_path), base_name),
    )
    .await
}

#[tauri::command]
async fn create_website_link(
    services: tauri::State<'_, NativeServices>,
    dir_path: String,
    base_name: String,
    url: String,
) -> Result<String, String> {
    wait(
        services
            .mutations
            .create_website_link(PathBuf::from(dir_path), base_name, url),
    )
    .await
}

#[tauri::command]
async fn delete_path_permanently(
    services: tauri::State<'_, NativeServices>,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    wait(
        services
            .mutations
            .delete_permanently(PathBuf::from(path), recursive),
    )
    .await
}

#[tauri::command]
async fn open_path(services: tauri::State<'_, NativeServices>, path: String) -> Result<(), String> {
    wait(services.integration.open(PathBuf::from(path))).await
}

#[tauri::command]
async fn reveal_in_file_manager(
    services: tauri::State<'_, NativeServices>,
    path: String,
) -> Result<(), String> {
    wait(services.integration.reveal(PathBuf::from(path))).await
}

#[tauri::command]
async fn quick_look(
    services: tauri::State<'_, NativeServices>,
    path: String,
) -> Result<(), String> {
    wait(services.integration.quick_look(PathBuf::from(path))).await
}

#[tauri::command]
async fn get_finder_tags(
    services: tauri::State<'_, NativeServices>,
    path: String,
) -> Result<Vec<String>, String> {
    wait(services.integration.finder_tags(PathBuf::from(path))).await
}

#[tauri::command]
async fn set_finder_tags(
    services: tauri::State<'_, NativeServices>,
    path: String,
    tags: Vec<String>,
) -> Result<(), String> {
    wait(
        services
            .integration
            .set_finder_tags(PathBuf::from(path), tags),
    )
    .await
}

#[tauri::command]
async fn get_finder_tag_colors(
    services: tauri::State<'_, NativeServices>,
) -> Result<HashMap<String, u8>, String> {
    wait(services.integration.finder_tag_colors()).await
}

#[tauri::command]
async fn open_with_app(
    services: tauri::State<'_, NativeServices>,
    path: String,
    app_name: String,
) -> Result<(), String> {
    wait(
        services
            .integration
            .open_with(PathBuf::from(path), app_name),
    )
    .await
}

#[tauri::command]
async fn get_apps_for_file(
    services: tauri::State<'_, NativeServices>,
    path: String,
) -> Result<Vec<explorie_native_services::AppInfo>, String> {
    wait(services.integration.apps_for_file(PathBuf::from(path))).await
}

#[tauri::command]
async fn get_file_icon(
    services: tauri::State<'_, NativeServices>,
    path: String,
) -> Result<Option<String>, String> {
    wait(services.previews.file_icon(PathBuf::from(path)))
        .await
        .map(|path| path.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn get_file_thumbnail(
    services: tauri::State<'_, NativeServices>,
    path: String,
    max_size: u32,
) -> Result<Option<String>, String> {
    wait(services.previews.thumbnail(PathBuf::from(path), max_size))
        .await
        .map(|path| path.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn generate_preview_artifact(
    services: tauri::State<'_, NativeServices>,
    path: String,
) -> Result<explorie_native_services::PreviewArtifact, String> {
    wait(services.previews.artifact(PathBuf::from(path))).await
}

#[tauri::command]
async fn get_preview_helpers_status(
    services: tauri::State<'_, NativeServices>,
) -> Result<Vec<explorie_native_services::HelperStatus>, String> {
    wait(services.previews.helper_status()).await
}

#[tauri::command]
async fn clear_preview_cache(services: tauri::State<'_, NativeServices>) -> Result<(), String> {
    wait(services.previews.clear_cache()).await
}

#[tauri::command]
async fn get_home_dir(services: tauri::State<'_, NativeServices>) -> Result<String, String> {
    wait(services.integration.home_dir())
        .await
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_platform(services: tauri::State<'_, NativeServices>) -> String {
    services.integration.platform().to_string()
}

#[tauri::command]
fn get_app_version(services: tauri::State<'_, NativeServices>) -> String {
    services.integration.app_version().to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompressResult {
    output_path: String,
    total_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractResult {
    output_dir: String,
    total_bytes: u64,
}

#[tauri::command]
async fn compress_files(
    services: tauri::State<'_, NativeServices>,
    paths: Vec<String>,
    output_path: String,
    format: String,
    compression_level: String,
    operation_id: String,
) -> Result<CompressResult, String> {
    let format = match format.to_ascii_lowercase().as_str() {
        "zip" => ArchiveFormat::Zip,
        "tar.gz" | "tgz" => ArchiveFormat::TarGz,
        "tar" => ArchiveFormat::Tar,
        "7z" => ArchiveFormat::SevenZ,
        _ => return Err(format!("Unsupported format: {format}")),
    };
    let compression_level = match compression_level.to_ascii_lowercase().as_str() {
        "none" => CompressionLevel::None,
        "fast" => CompressionLevel::Fast,
        "best" | "maximum" => CompressionLevel::Best,
        "normal" | "default" => CompressionLevel::Normal,
        _ => CompressionLevel::Normal,
    };
    wait(
        services
            .archives
            .compress(explorie_native_services::CompressRequest {
                paths: paths.into_iter().map(PathBuf::from).collect(),
                output_path: PathBuf::from(output_path),
                format,
                compression_level,
                password: None,
                operation_id,
            }),
    )
    .await
    .map(|result| CompressResult {
        output_path: result.output_path.to_string_lossy().into_owned(),
        total_bytes: result.total_bytes,
    })
}

#[tauri::command]
async fn extract_archive_cmd(
    services: tauri::State<'_, NativeServices>,
    archive_path: String,
    output_dir: String,
) -> Result<ExtractResult, String> {
    wait(
        services
            .archives
            .extract(explorie_native_services::ExtractRequest {
                archive_path: PathBuf::from(archive_path),
                output_dir: PathBuf::from(output_dir),
                password: None,
            }),
    )
    .await
    .map(|result| ExtractResult {
        output_dir: result.output_dir.to_string_lossy().into_owned(),
        total_bytes: result.total_bytes,
    })
}

#[tauri::command]
async fn list_archive(
    services: tauri::State<'_, NativeServices>,
    archive_path: String,
) -> Result<explorie_core::ArchiveInfo, String> {
    wait(services.archives.list(PathBuf::from(archive_path))).await
}

#[tauri::command]
async fn check_is_archive(
    services: tauri::State<'_, NativeServices>,
    path: String,
) -> Result<bool, String> {
    wait(services.archives.is_archive(PathBuf::from(path))).await
}

fn main() {
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
            if let Some(path) = explorie_native_services::listing::launch_directory_from_args(
                args.into_iter().map(OsString::from),
            ) {
                let _ = app.emit("open-path", path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(NativeServices::new(default_resources()))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let services = app.state::<NativeServices>().inner().clone();
            forward_service_events(app.handle().clone(), services);
            Ok(())
        })
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
            watch_paths,
            unwatch_paths,
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
            get_preview_helpers_status,
            clear_preview_cache,
            get_home_dir,
            get_platform,
            get_app_version,
            compress_files,
            extract_archive_cmd,
            list_archive,
            check_is_archive,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let services = app_handle.state::<NativeServices>();
            if services.mutations.request_exit() {
                services.mutations.cancel_all();
                api.prevent_exit();
            } else {
                api.prevent_exit();
                let services = services.inner().clone();
                let app_handle = app_handle.clone();
                thread::spawn(move || {
                    if services.remotes.disconnect_all_if_clean() {
                        app_handle.exit(0);
                    }
                });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "explorie-adapter-test-{}-{}",
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
            explorie_native_services::listing::launch_directory_from_args(args)
                .map(|path| path.to_string_lossy().into_owned()),
            Some(directory.0.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn legacy_events_preserve_frontend_state_names() {
        let event = FileOperationEvent {
            job_id: "job".into(),
            state: FileOperationState::Cancelled,
            progress: None,
            result: None,
            error: None,
        };
        assert_eq!(legacy_file_operation(event).state, "cancelled");
        assert_eq!(
            remote_state_name(RemoteDriveState::ApprovalRequired),
            "approval-required"
        );
    }
}
