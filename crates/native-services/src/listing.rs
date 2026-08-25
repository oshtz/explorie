use crate::{BlockingTask, ServiceContext, ServiceError, ServiceResult, SharedState};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ListRequest {
    pub path: PathBuf,
    pub calc_dir_size: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemLocations {
    pub desktop: Option<String>,
    pub documents: Option<String>,
    pub downloads: Option<String>,
    pub music: Option<String>,
    pub pictures: Option<String>,
    pub videos: Option<String>,
    pub home: Option<String>,
    pub drives: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DiskInfo {
    pub mount_point: String,
    pub total_space: u64,
    pub available_space: u64,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DirInfo {
    pub count: u64,
    pub size: u64,
}

#[derive(Clone)]
pub struct ListingService {
    context: ServiceContext,
    shared: Arc<SharedState>,
}

impl ListingService {
    pub(crate) fn new(context: ServiceContext, shared: Arc<SharedState>) -> Self {
        Self { context, shared }
    }

    pub fn list(&self, request: ListRequest) -> BlockingTask<Vec<explorie_core::FileEntry>> {
        self.context.spawn_blocking(move || {
            explorie_core::list_dir_with_sizes(&request.path, request.calc_dir_size)
                .map_err(ServiceError::from)
        })
    }

    pub fn list_blocking(
        &self,
        request: &ListRequest,
    ) -> ServiceResult<Vec<explorie_core::FileEntry>> {
        explorie_core::list_dir_with_sizes(&request.path, request.calc_dir_size)
            .map_err(ServiceError::from)
    }

    pub fn system_locations(&self) -> BlockingTask<SystemLocations> {
        let shared = Arc::clone(&self.shared);
        self.context
            .spawn_blocking(move || system_locations(&shared))
    }

    pub fn system_locations_blocking(&self) -> ServiceResult<SystemLocations> {
        system_locations(&self.shared)
    }

    pub fn disk_info(&self, path: PathBuf) -> BlockingTask<DiskInfo> {
        self.context
            .spawn_blocking(move || disk_info(&path).map_err(ServiceError::from))
    }

    pub fn disk_info_blocking(&self, path: &Path) -> ServiceResult<DiskInfo> {
        disk_info(path).map_err(ServiceError::from)
    }

    pub fn folder_size(&self, path: PathBuf) -> BlockingTask<u64> {
        self.context
            .spawn_blocking(move || explorie_core::dir_size(&path).map_err(ServiceError::from))
    }

    pub fn folder_size_blocking(&self, path: &Path) -> ServiceResult<u64> {
        explorie_core::dir_size(path).map_err(ServiceError::from)
    }

    pub fn dir_info(&self, path: PathBuf) -> BlockingTask<DirInfo> {
        self.context.spawn_blocking(move || {
            explorie_core::dir_info(&path)
                .map(|(count, size)| DirInfo { count, size })
                .map_err(ServiceError::from)
        })
    }

    pub fn dir_info_blocking(&self, path: &Path) -> ServiceResult<DirInfo> {
        explorie_core::dir_info(path)
            .map(|(count, size)| DirInfo { count, size })
            .map_err(ServiceError::from)
    }

    pub fn syncthing_root(&self, path: PathBuf) -> BlockingTask<Option<PathBuf>> {
        self.context
            .spawn_blocking(move || Ok(find_syncthing_root(&path)))
    }

    pub fn syncthing_root_blocking(&self, path: &Path) -> Option<PathBuf> {
        find_syncthing_root(path)
    }

    pub fn launch_path(&self, args: Vec<std::ffi::OsString>) -> BlockingTask<Option<PathBuf>> {
        self.context
            .spawn_blocking(move || Ok(launch_directory_from_args(args)))
    }

    pub fn launch_path_blocking(&self, args: Vec<std::ffi::OsString>) -> Option<PathBuf> {
        launch_directory_from_args(args)
    }
}

fn system_locations(shared: &SharedState) -> ServiceResult<SystemLocations> {
    let desktop = dirs::desktop_dir().map(|path| path_string(&path));
    let documents = dirs::document_dir().map(|path| path_string(&path));
    let downloads = dirs::download_dir().map(|path| path_string(&path));
    let music = dirs::audio_dir().map(|path| path_string(&path));
    let pictures = dirs::picture_dir().map(|path| path_string(&path));
    let videos = dirs::video_dir().map(|path| path_string(&path));
    let home = dirs::home_dir().map(|path| path_string(&path));

    let disks = sysinfo::Disks::new_with_refreshed_list();
    let drives = disks
        .iter()
        .map(|disk| disk.mount_point().to_path_buf())
        .filter(|path| !is_remote_root(shared, path))
        .map(|path| path_string(&path))
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

fn disk_info(path: &Path) -> std::io::Result<DiskInfo> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut best_match = None;
    let mut best_match_len = 0;
    for disk in disks.iter() {
        let mount = disk.mount_point();
        if path.starts_with(mount) {
            let length = mount.to_string_lossy().len();
            if length > best_match_len {
                best_match = Some(disk);
                best_match_len = length;
            }
        }
    }

    best_match
        .map(|disk| DiskInfo {
            mount_point: path_string(disk.mount_point()),
            total_space: disk.total_space(),
            available_space: disk.available_space(),
            name: disk.name().to_string_lossy().into_owned(),
        })
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Could not find disk for the given path",
            )
        })
}

fn is_remote_root(shared: &SharedState, path: &Path) -> bool {
    let value = normalize_path(path);
    shared
        .remote_roots
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(&value)
}

pub(crate) fn normalize_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.trim_end_matches('/').to_ascii_lowercase()
    } else {
        value.trim_end_matches('/').to_string()
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub(crate) fn find_syncthing_root(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|ancestor| ancestor.join(".stfolder").is_dir())
        .map(Path::to_path_buf)
}

pub fn launch_directory_from_args(
    args: impl IntoIterator<Item = std::ffi::OsString>,
) -> Option<PathBuf> {
    args.into_iter()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| path.is_dir())
}
