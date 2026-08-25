//! Native application services shared by the GPUI desktop target.
//!
//! This crate deliberately has no Tauri dependency.  The old Tauri binary is
//! only an adapter: it constructs [`ServiceContext`], delegates commands to
//! [`NativeServices`], and forwards [`ServiceEvent`] values to legacy event
//! names until the GPUI shell is fully cut over.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::task::{Context, Poll, Waker};
use std::thread;

pub mod archive;
pub mod integration;
pub mod listing;
pub mod metadata;
pub mod mutations;
pub mod preview;
pub mod remote_drives;
pub mod watcher;

pub use archive::{ArchiveFormat, ArchiveInfo, CompressionLevel};
pub use archive::{ArchiveService, CompressRequest, CompressResult, ExtractRequest, ExtractResult};
pub use explorie_core::{
    FileEntry, FileOperationKind, FileOperationProgress, FileOperationRequest, FileOperationResult,
};
pub use integration::{AppInfo, IntegrationService, SystemIntegrationStatus};
pub use listing::{DirInfo, DiskInfo, ListRequest, SystemLocations};
pub use metadata::MetadataService;
pub use mutations::{MutationService, SafeMutationRequest};
pub use preview::{HelperStatus, PreviewArtifact, PreviewService, TextPreview};
pub use remote_drives::{
    DisconnectResult, RemoteControlRequest, RemoteDriveBackend, RemoteDriveEnvironment,
    RemoteDriveExitBlocker, RemoteDriveManager, RemoteDriveProcess, RemoteDriveProfile,
    RemoteDriveService, RemoteDriveState, RemoteDriveStatus, RemoteMountRequest,
    RemoteProcessStatus,
};
pub use watcher::{WatchSubscription, WatcherService};

/// Stable classifications for errors crossing the native UI boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidInput,
    NotFound,
    PermissionDenied,
    Conflict,
    Cancelled,
    Unsupported,
    HelperMissing,
    RemoteUnavailable,
    Io,
    Busy,
    Internal,
}

/// A serializable, user-safe service error.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    pub operation: Option<String>,
}

impl ServiceError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            operation: None,
        }
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    pub fn operation(mut self, operation: impl Into<String>) -> Self {
        self.operation = Some(operation.into());
        self
    }
}

impl fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ServiceError {}

impl From<std::io::Error> for ServiceError {
    fn from(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => ErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            std::io::ErrorKind::AlreadyExists => ErrorCode::Conflict,
            std::io::ErrorKind::Interrupted => ErrorCode::Cancelled,
            std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidData => {
                ErrorCode::InvalidInput
            }
            std::io::ErrorKind::Unsupported => ErrorCode::Unsupported,
            _ => ErrorCode::Io,
        };
        Self::new(code, error.to_string())
    }
}

pub type ServiceResult<T> = Result<T, ServiceError>;

/// Resource locations supplied by the host application.
///
/// Nothing in the service layer asks Tauri for paths.  Packaged hosts inject
/// the resource and cache directories, while tests can point both at a
/// disposable fixture.
#[derive(Clone, Debug)]
pub struct ResourcePaths {
    pub resource_dir: Option<PathBuf>,
    pub cache_dir: PathBuf,
    pub manifest_dir: PathBuf,
    pub app_version: String,
    pub current_exe: Option<PathBuf>,
}

impl ResourcePaths {
    pub fn new(cache_dir: impl Into<PathBuf>) -> Self {
        Self {
            resource_dir: None,
            cache_dir: cache_dir.into(),
            manifest_dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
            app_version: String::new(),
            current_exe: std::env::current_exe().ok(),
        }
    }

    pub fn with_resource_dir(mut self, resource_dir: Option<PathBuf>) -> Self {
        self.resource_dir = resource_dir;
        self
    }

    pub fn with_manifest_dir(mut self, manifest_dir: impl Into<PathBuf>) -> Self {
        self.manifest_dir = manifest_dir.into();
        self
    }

    pub fn with_app_version(mut self, version: impl Into<String>) -> Self {
        self.app_version = version.into();
        self
    }

    pub fn with_current_exe(mut self, current_exe: Option<PathBuf>) -> Self {
        self.current_exe = current_exe;
        self
    }

    pub fn test(root: &Path) -> Self {
        Self::new(root.join("cache"))
            .with_resource_dir(Some(root.join("resources")))
            .with_manifest_dir(root)
            .with_current_exe(Some(root.join("explorie-test")))
    }
}

impl Default for ResourcePaths {
    fn default() -> Self {
        let cache = dirs::cache_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("explorie");
        Self::new(cache)
    }
}

/// A typed event stream shared by all service groups.
#[derive(Clone, Default)]
pub struct ServiceEvents {
    subscribers: Arc<Mutex<Vec<mpsc::Sender<ServiceEvent>>>>,
}

impl ServiceEvents {
    pub fn subscribe(&self) -> mpsc::Receiver<ServiceEvent> {
        let (sender, receiver) = mpsc::channel();
        self.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(sender);
        receiver
    }

    pub(crate) fn publish(&self, event: ServiceEvent) {
        let mut subscribers = self
            .subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        subscribers.retain(|subscriber| subscriber.send(event.clone()).is_ok());
    }
}

/// Typed events emitted by native jobs and subscriptions.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceEvent {
    FileOperation(FileOperationEvent),
    ArchiveProgress(ArchiveProgressEvent),
    RemoteDriveStatus(RemoteDriveStatus),
    RemoteDriveExitBlocked(RemoteDriveExitBlocker),
    MutationIdle,
    HelperStatus(HelperStatusEvent),
    Watcher(WatcherEvent),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationEvent {
    pub job_id: String,
    pub state: FileOperationState,
    pub progress: Option<explorie_core::FileOperationProgress>,
    pub result: Option<explorie_core::FileOperationResult>,
    pub error: Option<ServiceError>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileOperationState {
    Running,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveProgressEvent {
    pub operation_id: String,
    pub processed_bytes: u64,
    pub total_bytes: u64,
    pub current_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperStatusEvent {
    pub helper: String,
    pub status: HelperStatus,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherEvent {
    pub registration_id: u64,
    pub state: WatcherState,
    pub paths: Vec<PathBuf>,
    pub error: Option<ServiceError>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WatcherState {
    Changed,
    Failed,
    Stopped,
}

/// Host context shared by all native services.
#[derive(Clone)]
pub struct ServiceContext {
    resources: Arc<ResourcePaths>,
    events: ServiceEvents,
}

impl ServiceContext {
    pub fn new(resources: ResourcePaths) -> Self {
        Self {
            resources: Arc::new(resources),
            events: ServiceEvents::default(),
        }
    }

    pub fn resources(&self) -> &ResourcePaths {
        &self.resources
    }

    pub fn events(&self) -> ServiceEvents {
        self.events.clone()
    }

    pub fn subscribe(&self) -> mpsc::Receiver<ServiceEvent> {
        self.events.subscribe()
    }

    pub fn spawn_blocking<T, F>(&self, operation: F) -> BlockingTask<T>
    where
        T: Send + 'static,
        F: FnOnce() -> ServiceResult<T> + Send + 'static,
    {
        let (sender, receiver) = mpsc::sync_channel(1);
        let waker = Arc::new(Mutex::new(None::<Waker>));
        let worker_waker = Arc::clone(&waker);
        thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
                .unwrap_or_else(|_| {
                    Err(ServiceError::new(
                        ErrorCode::Internal,
                        "Native service worker panicked",
                    ))
                });
            let _ = sender.send(result);
            if let Some(waker) = worker_waker
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
            {
                waker.wake();
            }
        });
        BlockingTask { receiver, waker }
    }
}

impl Default for ServiceContext {
    fn default() -> Self {
        Self::new(ResourcePaths::default())
    }
}

/// A standard-thread task used by GPUI adapters for blocking service work.
pub struct BlockingTask<T> {
    receiver: mpsc::Receiver<ServiceResult<T>>,
    waker: Arc<Mutex<Option<Waker>>>,
}

impl<T> BlockingTask<T> {
    /// Block a non-UI caller until the worker completes. UI adapters should
    /// await this task instead.
    pub fn wait(self) -> ServiceResult<T> {
        self.receiver.recv().unwrap_or_else(|_| {
            Err(ServiceError::new(
                ErrorCode::Internal,
                "Native service worker stopped before returning a result",
            ))
        })
    }
}

impl<T> Unpin for BlockingTask<T> {}

impl<T> Future for BlockingTask<T> {
    type Output = ServiceResult<T>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let task = self.get_mut();
        match task.receiver.try_recv() {
            Ok(result) => Poll::Ready(result),
            Err(mpsc::TryRecvError::Disconnected) => Poll::Ready(Err(ServiceError::new(
                ErrorCode::Internal,
                "Native service worker stopped before returning a result",
            ))),
            Err(mpsc::TryRecvError::Empty) => {
                *task
                    .waker
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) =
                    Some(context.waker().clone());
                match task.receiver.try_recv() {
                    Ok(result) => Poll::Ready(result),
                    Err(mpsc::TryRecvError::Disconnected) => Poll::Ready(Err(ServiceError::new(
                        ErrorCode::Internal,
                        "Native service worker stopped before returning a result",
                    ))),
                    Err(mpsc::TryRecvError::Empty) => Poll::Pending,
                }
            }
        }
    }
}

pub(crate) struct SharedState {
    pub events: ServiceEvents,
    pub remote_roots: Mutex<HashSet<String>>,
    pub next_job_id: AtomicU64,
    pub cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub active_mutations: AtomicU64,
    pub exit_requested: AtomicBool,
}

impl SharedState {
    fn new(events: ServiceEvents) -> Self {
        Self {
            events,
            remote_roots: Mutex::new(HashSet::new()),
            next_job_id: AtomicU64::new(0),
            cancellations: Mutex::new(HashMap::new()),
            active_mutations: AtomicU64::new(0),
            exit_requested: AtomicBool::new(false),
        }
    }
}

/// Keeps the process from exiting while a native mutation is in flight.
///
/// The guard is intentionally shared by all mutating service groups, not just
/// file-operation jobs. Metadata, archive, integration, and remote-drive
/// writes all need the same exit-blocking semantics.
pub(crate) struct ActiveOperation {
    shared: Arc<SharedState>,
}

impl ActiveOperation {
    pub(crate) fn new(shared: Arc<SharedState>) -> Self {
        shared.active_mutations.fetch_add(1, Ordering::AcqRel);
        Self { shared }
    }
}

impl Drop for ActiveOperation {
    fn drop(&mut self) {
        if self.shared.active_mutations.fetch_sub(1, Ordering::AcqRel) == 1
            && self.shared.exit_requested.swap(false, Ordering::AcqRel)
        {
            self.shared.events.publish(ServiceEvent::MutationIdle);
        }
    }
}

/// All native capabilities exposed as one GPUI-friendly service context.
#[derive(Clone)]
pub struct NativeServices {
    pub context: ServiceContext,
    pub listing: listing::ListingService,
    pub metadata: metadata::MetadataService,
    pub mutations: mutations::MutationService,
    pub archives: archive::ArchiveService,
    pub previews: preview::PreviewService,
    pub remotes: remote_drives::RemoteDriveService,
    pub integration: integration::IntegrationService,
    pub watcher: watcher::WatcherService,
}

impl NativeServices {
    pub fn new(resources: ResourcePaths) -> Self {
        let context = ServiceContext::new(resources);
        Self::from_context(context)
    }

    pub fn from_context(context: ServiceContext) -> Self {
        Self::from_context_with_remote_backend(context, None)
    }

    /// Construct services with a host-provided remote-drive backend.
    ///
    /// Production uses the system backend. Tests can inject process/helper
    /// implementations without changing platform safety checks or relying on
    /// process-wide environment switches.
    pub fn with_remote_backend(
        resources: ResourcePaths,
        backend: Arc<dyn remote_drives::RemoteDriveBackend>,
    ) -> Self {
        Self::from_context_with_remote_backend(ServiceContext::new(resources), Some(backend))
    }

    fn from_context_with_remote_backend(
        context: ServiceContext,
        backend: Option<Arc<dyn remote_drives::RemoteDriveBackend>>,
    ) -> Self {
        let shared = Arc::new(SharedState::new(context.events()));
        Self {
            listing: listing::ListingService::new(context.clone(), Arc::clone(&shared)),
            metadata: metadata::MetadataService::new(context.clone(), Arc::clone(&shared)),
            mutations: mutations::MutationService::new(context.clone(), Arc::clone(&shared)),
            archives: archive::ArchiveService::new(context.clone(), Arc::clone(&shared)),
            previews: preview::PreviewService::new(context.clone()),
            remotes: match backend {
                Some(backend) => remote_drives::RemoteDriveService::with_backend(
                    context.clone(),
                    Arc::clone(&shared),
                    backend,
                ),
                None => {
                    remote_drives::RemoteDriveService::new(context.clone(), Arc::clone(&shared))
                }
            },
            integration: integration::IntegrationService::new(context.clone(), Arc::clone(&shared)),
            watcher: watcher::WatcherService::new(context.clone()),
            context,
        }
    }

    pub fn subscribe(&self) -> mpsc::Receiver<ServiceEvent> {
        self.context.subscribe()
    }

    pub fn resources(&self) -> &ResourcePaths {
        self.context.resources()
    }
}

impl Default for NativeServices {
    fn default() -> Self {
        Self::new(ResourcePaths::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    struct WakeSignal(AtomicBool);

    impl std::task::Wake for WakeSignal {
        fn wake(self: Arc<Self>) {
            self.0.store(true, Ordering::Release);
        }
    }

    #[test]
    fn blocking_task_can_be_awaited_without_joining_the_calling_thread() {
        let context = ServiceContext::default();
        let mut task = context.spawn_blocking(|| {
            thread::sleep(std::time::Duration::from_millis(10));
            Ok(42_u64)
        });
        let signal = Arc::new(WakeSignal(AtomicBool::new(false)));
        let waker = Waker::from(Arc::clone(&signal));
        let mut task = Pin::new(&mut task);
        let mut task_context = Context::from_waker(&waker);

        loop {
            match Future::poll(task.as_mut(), &mut task_context) {
                Poll::Ready(result) => {
                    assert_eq!(result.unwrap(), 42);
                    break;
                }
                Poll::Pending => {
                    while !signal.0.swap(false, Ordering::AcqRel) {
                        thread::yield_now();
                    }
                }
            }
        }
    }

    #[test]
    fn native_result_wire_names_match_existing_desktop_consumers() {
        let disk = serde_json::to_value(DiskInfo {
            mount_point: "C:\\".into(),
            total_space: 10,
            available_space: 5,
            name: "System".into(),
        })
        .unwrap();
        assert!(disk.get("mount_point").is_some());
        assert!(disk.get("total_space").is_some());
        assert!(disk.get("available_space").is_some());

        let artifact = serde_json::to_value(PreviewArtifact {
            kind: "pdf".into(),
            path: PathBuf::from("preview.pdf"),
            mime_type: "application/pdf".into(),
            tool: "soffice".into(),
        })
        .unwrap();
        assert!(artifact.get("mime_type").is_some());

        let app = serde_json::to_value(AppInfo {
            name: "Preview".into(),
            path: PathBuf::from("/Applications/Preview.app"),
            bundle_id: Some("com.apple.Preview".into()),
        })
        .unwrap();
        assert!(app.get("bundle_id").is_some());

        let archive = serde_json::to_value(CompressResult {
            output_path: PathBuf::from("bundle.zip"),
            total_bytes: 10,
        })
        .unwrap();
        assert!(archive.get("output_path").is_some());
        assert!(archive.get("total_bytes").is_some());
    }

    #[test]
    fn credential_bearing_requests_redact_passwords_in_debug_output() {
        let secret = "do-not-print-this";
        let archive = CompressRequest {
            paths: vec![PathBuf::from("source.txt")],
            output_path: PathBuf::from("bundle.zip"),
            format: ArchiveFormat::Zip,
            compression_level: CompressionLevel::Normal,
            password: Some(secret.into()),
            operation_id: "job".into(),
        };
        assert!(!format!("{archive:?}").contains(secret));

        let extract = ExtractRequest {
            archive_path: PathBuf::from("bundle.zip"),
            output_dir: PathBuf::from("output"),
            password: Some(secret.into()),
        };
        assert!(!format!("{extract:?}").contains(secret));

        let remote = RemoteMountRequest {
            profile: RemoteDriveProfile {
                id: "profile".into(),
                name: "Remote".into(),
                remote: "remote".into(),
                remote_path: String::new(),
                mount_target: "D:".into(),
            },
            rclone: PathBuf::from("rclone"),
            cache_dir: PathBuf::from("cache"),
            rc_url: "http://127.0.0.1:1/".into(),
            rc_user: "explorie".into(),
            rc_pass: secret.into(),
            helper_port: None,
        };
        assert!(!format!("{remote:?}").contains(secret));

        let control = RemoteControlRequest {
            rclone: PathBuf::from("rclone"),
            rc_url: "http://127.0.0.1:1/".into(),
            rc_user: "explorie".into(),
            rc_pass: secret.into(),
            endpoint: "core/quit".into(),
        };
        assert!(!format!("{control:?}").contains(secret));
    }
}
