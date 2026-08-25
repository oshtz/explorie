use crate::{
    ActiveOperation, ArchiveProgressEvent, BlockingTask, ErrorCode, ServiceContext, ServiceError,
    ServiceEvent, SharedState,
};
use explorie_core::archive::{self, CompressOptions};
pub use explorie_core::archive::{ArchiveFormat, ArchiveInfo, CompressionLevel};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressRequest {
    pub paths: Vec<PathBuf>,
    pub output_path: PathBuf,
    pub format: ArchiveFormat,
    pub compression_level: CompressionLevel,
    #[serde(default)]
    pub password: Option<String>,
    pub operation_id: String,
}

impl fmt::Debug for CompressRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CompressRequest")
            .field("paths", &self.paths)
            .field("output_path", &self.output_path)
            .field("format", &self.format)
            .field("compression_level", &self.compression_level)
            .field("password", &self.password.as_ref().map(|_| "[redacted]"))
            .field("operation_id", &self.operation_id)
            .finish()
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractRequest {
    pub archive_path: PathBuf,
    pub output_dir: PathBuf,
    #[serde(default)]
    pub password: Option<String>,
}

impl fmt::Debug for ExtractRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExtractRequest")
            .field("archive_path", &self.archive_path)
            .field("output_dir", &self.output_dir)
            .field("password", &self.password.as_ref().map(|_| "[redacted]"))
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CompressResult {
    pub output_path: PathBuf,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ExtractResult {
    pub output_dir: PathBuf,
    pub total_bytes: u64,
}

#[derive(Clone)]
pub struct ArchiveService {
    context: ServiceContext,
    shared: Arc<SharedState>,
}

impl ArchiveService {
    pub(crate) fn new(context: ServiceContext, shared: Arc<SharedState>) -> Self {
        Self { context, shared }
    }

    pub fn compress(&self, request: CompressRequest) -> BlockingTask<CompressResult> {
        let context = self.context.clone();
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if request.paths.iter().any(|path| remote_root(&shared, path))
                || remote_root(&shared, &request.output_path)
            {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to mutate a managed remote-drive root",
                ));
            }
            let _guard = guard;
            let operation_id = request.operation_id.clone();
            let total_bytes = archive::create_archive_with_progress(
                &request.paths,
                &request.output_path,
                &CompressOptions {
                    format: request.format,
                    compression_level: request.compression_level,
                    password: request.password,
                },
                |progress| {
                    context
                        .events()
                        .publish(ServiceEvent::ArchiveProgress(ArchiveProgressEvent {
                            operation_id: operation_id.clone(),
                            processed_bytes: progress.processed_bytes,
                            total_bytes: progress.total_bytes,
                            current_path: progress.current_path,
                        }));
                },
            )
            .map_err(ServiceError::from)?;
            Ok(CompressResult {
                output_path: request.output_path,
                total_bytes,
            })
        })
    }

    pub fn extract(&self, request: ExtractRequest) -> BlockingTask<ExtractResult> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &request.output_dir) {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to mutate a managed remote-drive root",
                ));
            }
            let _guard = guard;
            let total_bytes = archive::extract_archive_with_password(
                &request.archive_path,
                &request.output_dir,
                request.password.as_deref(),
            )
            .map_err(ServiceError::from)?;
            Ok(ExtractResult {
                output_dir: request.output_dir,
                total_bytes,
            })
        })
    }

    pub fn list(&self, archive_path: PathBuf) -> BlockingTask<ArchiveInfo> {
        self.context.spawn_blocking(move || {
            archive::list_archive_contents(&archive_path).map_err(ServiceError::from)
        })
    }

    pub fn is_archive(&self, path: PathBuf) -> BlockingTask<bool> {
        self.context
            .spawn_blocking(move || Ok(archive::is_archive(Path::new(&path))))
    }
}

fn remote_root(shared: &SharedState, path: &Path) -> bool {
    shared
        .remote_roots
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(&crate::listing::normalize_path(path))
}
