use std::ffi::OsString;
use std::io;
use std::path::PathBuf;

use explorie_core::FileEntry;
use gpui::{Context, Render, Task, Window, div, prelude::*, rgb};

pub const APP_IDENTIFIER: &str = "com.omershatz.explorie";
pub const APP_NAME: &str = "explorie";
pub const DEFAULT_WINDOW_WIDTH: f32 = 1024.0;
pub const DEFAULT_WINDOW_HEIGHT: f32 = 768.0;
pub const MIN_WINDOW_WIDTH: f32 = 800.0;
pub const MIN_WINDOW_HEIGHT: f32 = 600.0;

/// Finds the first existing directory argument after the executable name.
///
/// This intentionally matches the current Tauri launch contract: non-directory
/// arguments are ignored, and no argument produces `None` for the caller to
/// replace with its normal fallback location.
pub fn parse_startup_path(args: impl IntoIterator<Item = OsString>) -> Option<PathBuf> {
    args.into_iter()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| path.is_dir())
}

/// Typed request sent from a GPUI view to the native service boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryListingRequest {
    pub path: PathBuf,
    pub calc_dir_size: bool,
}

impl DirectoryListingRequest {
    pub fn new(path: impl Into<PathBuf>, calc_dir_size: bool) -> Self {
        Self {
            path: path.into(),
            calc_dir_size,
        }
    }
}

/// Native service boundary used by the GPUI target.
pub trait DirectoryService: Clone + Send + Sync + 'static {
    fn list_dir_with_sizes(&self, request: &DirectoryListingRequest) -> io::Result<Vec<FileEntry>>;
}

/// The production directory service delegates directly to explorie-core.
#[derive(Clone, Copy, Debug, Default)]
pub struct CoreDirectoryService;

impl DirectoryService for CoreDirectoryService {
    fn list_dir_with_sizes(&self, request: &DirectoryListingRequest) -> io::Result<Vec<FileEntry>> {
        explorie_core::list_dir_with_sizes(&request.path, request.calc_dir_size)
    }
}

#[derive(Debug)]
pub enum DirectoryEvent {
    Listed {
        request: DirectoryListingRequest,
        entries: Vec<FileEntry>,
    },
    Failed {
        request: DirectoryListingRequest,
        error: DirectoryServiceError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryServiceError {
    pub path: PathBuf,
    pub message: String,
}

/// Builds the background task consumed by GPUI's background executor.
///
/// `list_dir_with_sizes` is synchronous by design in explorie-core. This
/// future must therefore be scheduled on `BackgroundExecutor`, never on the
/// foreground executor or inside a render callback.
pub async fn list_directory_task<S>(service: S, request: DirectoryListingRequest) -> DirectoryEvent
where
    S: DirectoryService,
{
    let result = service.list_dir_with_sizes(&request);
    match result {
        Ok(entries) => DirectoryEvent::Listed { request, entries },
        Err(error) => DirectoryEvent::Failed {
            error: DirectoryServiceError {
                path: request.path.clone(),
                message: error.to_string(),
            },
            request,
        },
    }
}

#[derive(Debug)]
enum ListingState {
    Loading,
    Ready(Vec<FileEntry>),
    Failed(String),
}

/// Minimal native browsing surface used to prove the service/task handoff.
pub struct DirectoryWindow {
    path: PathBuf,
    service: CoreDirectoryService,
    state: ListingState,
    listing_task: Option<Task<()>>,
}

impl DirectoryWindow {
    pub fn new(path: PathBuf, service: CoreDirectoryService) -> Self {
        Self {
            path,
            service,
            state: ListingState::Loading,
            listing_task: None,
        }
    }

    /// Starts one listing without doing filesystem work on the GPUI UI thread.
    pub fn start_listing(&mut self, cx: &mut Context<Self>) {
        let service = self.service;
        let request = DirectoryListingRequest::new(self.path.clone(), false);
        self.state = ListingState::Loading;

        self.listing_task = Some(cx.spawn(async move |this, cx| {
            let event = cx
                .background_executor()
                .spawn(list_directory_task(service, request))
                .await;

            let _ = this.update(cx, |view, cx| {
                view.apply_event(event);
                cx.notify();
            });
        }));
    }

    fn apply_event(&mut self, event: DirectoryEvent) {
        match event {
            DirectoryEvent::Listed { request, entries } => {
                self.path = request.path;
                self.state = ListingState::Ready(entries);
            }
            DirectoryEvent::Failed { error, .. } => {
                self.state = ListingState::Failed(error.message);
            }
        }
    }
}

impl Render for DirectoryWindow {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let path = self.path.to_string_lossy().to_string();
        let body = match &self.state {
            ListingState::Loading => div()
                .id("listing-loading")
                .text_sm()
                .child("Loading files...")
                .into_any_element(),
            ListingState::Failed(error) => div()
                .id("listing-error")
                .text_sm()
                .text_color(rgb(0xff8f8f))
                .child(format!("Unable to list directory: {error}"))
                .into_any_element(),
            ListingState::Ready(entries) => div()
                .id("listing-results")
                .flex()
                .flex_col()
                .flex_1()
                .gap_1()
                .overflow_y_scroll()
                .children(entries.iter().enumerate().map(|(index, entry)| {
                    let kind = if entry.is_dir { "DIR " } else { "FILE" };
                    div()
                        .id(("entry", index))
                        .w_full()
                        .child(format!("{kind}  {}", entry.path.display()))
                }))
                .into_any_element(),
        };

        div()
            .id("explorie-window")
            .flex()
            .flex_col()
            .size_full()
            .gap_2()
            .p_4()
            .bg(rgb(0x171717))
            .text_color(rgb(0xf5f5f5))
            .child(div().id("app-title").text_xl().child(APP_NAME))
            .child(div().id("current-path").text_sm().child(path))
            .child(body)
    }
}

#[cfg(windows)]
pub struct SingleInstanceGuard {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
pub fn acquire_single_instance() -> io::Result<Option<SingleInstanceGuard>> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let name: Vec<u16> = std::ffi::OsStr::new(&format!("Local\\{APP_IDENTIFIER}"))
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Ok(None);
    }
    Ok(Some(SingleInstanceGuard { handle }))
}

#[cfg(target_os = "macos")]
pub struct SingleInstanceGuard {
    file: std::fs::File,
}

#[cfg(target_os = "macos")]
pub fn acquire_single_instance() -> io::Result<Option<SingleInstanceGuard>> {
    use std::os::fd::AsRawFd;

    let path = std::env::temp_dir().join(format!("{APP_IDENTIFIER}.lock"));
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        return Ok(Some(SingleInstanceGuard { file }));
    }

    let error = io::Error::last_os_error();
    if matches!(error.raw_os_error(), Some(code) if code == libc::EAGAIN || code == libc::EWOULDBLOCK)
    {
        Ok(None)
    } else {
        Err(error)
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub struct SingleInstanceGuard;

#[cfg(not(any(windows, target_os = "macos")))]
pub fn acquire_single_instance() -> io::Result<Option<SingleInstanceGuard>> {
    Ok(Some(SingleInstanceGuard))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn fixture_dir() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "explorie-gpui-fixture-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn startup_path_uses_the_first_existing_directory_argument() {
        let directory = fixture_dir();
        let args = [
            OsString::from("explorie-gpui"),
            OsString::from("missing-directory"),
            directory.clone().into_os_string(),
        ];

        assert_eq!(parse_startup_path(args), Some(directory.clone()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_path_rejects_files_and_missing_arguments() {
        let directory = fixture_dir();
        let file = directory.join("not-a-directory.txt");
        fs::write(&file, b"fixture").unwrap();
        let args = [
            OsString::from("explorie-gpui"),
            file.into_os_string(),
            OsString::from("missing-directory"),
        ];

        assert_eq!(parse_startup_path(args), None);
        fs::remove_dir_all(directory).unwrap();
    }

    #[gpui::test]
    async fn service_task_handoff_returns_a_real_core_listing(cx: &TestAppContext) {
        let directory = fixture_dir();
        fs::write(directory.join("fixture.txt"), b"fixture").unwrap();
        fs::create_dir(directory.join("nested")).unwrap();

        let task = cx.background_executor.spawn(list_directory_task(
            CoreDirectoryService,
            DirectoryListingRequest::new(directory.clone(), false),
        ));
        let event = task.await;

        match event {
            DirectoryEvent::Listed { entries, .. } => {
                assert_eq!(entries.len(), 2);
                assert!(entries.iter().any(|entry| {
                    entry
                        .path
                        .file_name()
                        .is_some_and(|name| name == "fixture.txt")
                }));
                assert!(
                    entries.iter().any(|entry| {
                        entry.path.file_name().is_some_and(|name| name == "nested")
                    })
                );
            }
            DirectoryEvent::Failed { error, .. } => panic!("listing failed: {}", error.message),
        }

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn window_contract_is_explicit() {
        assert_eq!(DEFAULT_WINDOW_WIDTH, 1024.0);
        assert_eq!(DEFAULT_WINDOW_HEIGHT, 768.0);
        assert_eq!(MIN_WINDOW_WIDTH, 800.0);
        assert_eq!(MIN_WINDOW_HEIGHT, 600.0);
        assert_eq!(APP_IDENTIFIER, "com.omershatz.explorie");
    }
}
