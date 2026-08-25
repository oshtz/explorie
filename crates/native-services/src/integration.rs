use crate::{ActiveOperation, BlockingTask, ErrorCode, ServiceContext, ServiceError, SharedState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemIntegrationStatus {
    pub supported: bool,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AppInfo {
    pub name: String,
    pub path: PathBuf,
    pub bundle_id: Option<String>,
}

pub trait FinderTagsBackend: Send + Sync {
    fn supported(&self) -> bool;
    fn get(&self, path: &Path) -> io::Result<Vec<String>>;
    fn set(&self, path: &Path, tags: &[String]) -> io::Result<()>;
}

pub trait PlatformActionsBackend: Send + Sync {
    fn open(&self, path: &Path) -> io::Result<()>;
    fn reveal(&self, path: &Path) -> io::Result<()>;
    fn quick_look(&self, path: &Path) -> io::Result<()>;
    fn open_with(&self, path: &Path, app_name: &str) -> io::Result<()>;
    fn apps_for_file(&self, path: &Path) -> io::Result<Vec<AppInfo>>;
}

struct SystemFinderTagsBackend;

struct SystemPlatformActionsBackend;

impl FinderTagsBackend for SystemFinderTagsBackend {
    fn supported(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn get(&self, path: &Path) -> io::Result<Vec<String>> {
        get_finder_tags(path)
    }

    fn set(&self, path: &Path, tags: &[String]) -> io::Result<()> {
        set_finder_tags(path, tags)
    }
}

impl PlatformActionsBackend for SystemPlatformActionsBackend {
    fn open(&self, path: &Path) -> io::Result<()> {
        open::that_detached(path).map_err(io::Error::other)
    }

    fn reveal(&self, path: &Path) -> io::Result<()> {
        reveal(path)
    }

    fn quick_look(&self, path: &Path) -> io::Result<()> {
        quick_look(path)
    }

    fn open_with(&self, path: &Path, app_name: &str) -> io::Result<()> {
        open_with_app(path, app_name)
    }

    fn apps_for_file(&self, path: &Path) -> io::Result<Vec<AppInfo>> {
        apps_for_file(path)
    }
}

#[derive(Clone)]
pub struct IntegrationService {
    context: ServiceContext,
    shared: Arc<SharedState>,
    finder_tags: Arc<dyn FinderTagsBackend>,
    platform_actions: Arc<dyn PlatformActionsBackend>,
}

impl IntegrationService {
    pub(crate) fn new(context: ServiceContext, shared: Arc<SharedState>) -> Self {
        Self::with_backends(
            context,
            shared,
            Arc::new(SystemFinderTagsBackend),
            Arc::new(SystemPlatformActionsBackend),
        )
    }

    pub(crate) fn with_finder_tags_backend(
        context: ServiceContext,
        shared: Arc<SharedState>,
        finder_tags: Arc<dyn FinderTagsBackend>,
    ) -> Self {
        Self::with_backends(
            context,
            shared,
            finder_tags,
            Arc::new(SystemPlatformActionsBackend),
        )
    }

    pub(crate) fn with_platform_actions_backend(
        context: ServiceContext,
        shared: Arc<SharedState>,
        platform_actions: Arc<dyn PlatformActionsBackend>,
    ) -> Self {
        Self::with_backends(
            context,
            shared,
            Arc::new(SystemFinderTagsBackend),
            platform_actions,
        )
    }

    pub(crate) fn with_backends(
        context: ServiceContext,
        shared: Arc<SharedState>,
        finder_tags: Arc<dyn FinderTagsBackend>,
        platform_actions: Arc<dyn PlatformActionsBackend>,
    ) -> Self {
        Self {
            context,
            shared,
            finder_tags,
            platform_actions,
        }
    }

    pub fn status(&self) -> BlockingTask<SystemIntegrationStatus> {
        self.context
            .spawn_blocking(|| system_integration_status().map_err(ServiceError::from))
    }

    pub fn set_status(&self, enabled: bool) -> BlockingTask<SystemIntegrationStatus> {
        let guard = ActiveOperation::new(Arc::clone(&self.shared));
        self.context.spawn_blocking(move || {
            let _guard = guard;
            set_system_integration(enabled).map_err(ServiceError::from)
        })
    }

    pub fn open(&self, path: PathBuf) -> BlockingTask<()> {
        let backend = Arc::clone(&self.platform_actions);
        self.context.spawn_blocking(move || {
            backend
                .open(&path)
                .map_err(|error| ServiceError::from(error).operation("open"))
        })
    }

    pub fn reveal(&self, path: PathBuf) -> BlockingTask<()> {
        let backend = Arc::clone(&self.platform_actions);
        self.context.spawn_blocking(move || {
            backend
                .reveal(&path)
                .map_err(|error| ServiceError::from(error).operation("reveal"))
        })
    }

    pub fn quick_look(&self, path: PathBuf) -> BlockingTask<()> {
        let backend = Arc::clone(&self.platform_actions);
        self.context.spawn_blocking(move || {
            backend
                .quick_look(&path)
                .map_err(|error| ServiceError::from(error).operation("quick_look"))
        })
    }

    pub fn finder_tags(&self, path: PathBuf) -> BlockingTask<Vec<String>> {
        let backend = Arc::clone(&self.finder_tags);
        self.context
            .spawn_blocking(move || backend.get(&path).map_err(ServiceError::from))
    }

    pub fn set_finder_tags(&self, path: PathBuf, tags: Vec<String>) -> BlockingTask<()> {
        let shared = Arc::clone(&self.shared);
        let backend = Arc::clone(&self.finder_tags);
        let guard = ActiveOperation::new(Arc::clone(&self.shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &path) {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to mutate a managed remote-drive root",
                ));
            }
            let _guard = guard;
            backend.set(&path, &tags).map_err(ServiceError::from)
        })
    }

    pub fn finder_tags_supported(&self) -> bool {
        self.finder_tags.supported()
    }

    pub fn finder_tag_colors(&self) -> BlockingTask<HashMap<String, u8>> {
        self.context.spawn_blocking(|| Ok(finder_tag_colors()))
    }

    pub fn open_with(&self, path: PathBuf, app_name: String) -> BlockingTask<()> {
        let backend = Arc::clone(&self.platform_actions);
        self.context.spawn_blocking(move || {
            backend
                .open_with(&path, &app_name)
                .map_err(|error| ServiceError::from(error).operation("open_with"))
        })
    }

    pub fn apps_for_file(&self, path: PathBuf) -> BlockingTask<Vec<AppInfo>> {
        let backend = Arc::clone(&self.platform_actions);
        self.context.spawn_blocking(move || {
            backend
                .apps_for_file(&path)
                .map_err(|error| ServiceError::from(error).operation("apps_for_file"))
        })
    }

    pub fn home_dir(&self) -> BlockingTask<PathBuf> {
        self.context.spawn_blocking(|| {
            dirs::home_dir().ok_or_else(|| {
                ServiceError::new(ErrorCode::NotFound, "Could not determine home directory")
            })
        })
    }

    pub fn platform(&self) -> &'static str {
        std::env::consts::OS
    }

    pub fn app_version(&self) -> &str {
        &self.context.resources().app_version
    }
}

fn remote_root(shared: &SharedState, path: &Path) -> bool {
    shared
        .remote_roots
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(&crate::listing::normalize_path(path))
}

fn system_integration_status() -> io::Result<SystemIntegrationStatus> {
    #[cfg(windows)]
    {
        windows_integration::enabled().map(|enabled| SystemIntegrationStatus {
            supported: true,
            enabled,
        })
    }
    #[cfg(not(windows))]
    Ok(SystemIntegrationStatus {
        supported: false,
        enabled: false,
    })
}

fn set_system_integration(enabled: bool) -> io::Result<SystemIntegrationStatus> {
    #[cfg(windows)]
    {
        windows_integration::set_enabled(enabled)?;
        system_integration_status()
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "System integration is currently available only on Windows.",
        ))
    }
}

#[cfg(target_os = "macos")]
fn reveal(path: &Path) -> io::Result<()> {
    Command::new("open")
        .args(["-R"])
        .arg(path)
        .spawn()
        .map(|_| ())
}

#[cfg(windows)]
fn reveal(path: &Path) -> io::Result<()> {
    Command::new("explorer")
        .args(["/select,"])
        .arg(path)
        .spawn()
        .map(|_| ())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn reveal(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Reveal in file manager is not supported on this platform.",
    ))
}

#[cfg(target_os = "macos")]
fn quick_look(path: &Path) -> io::Result<()> {
    Command::new("qlmanage")
        .args(["-p"])
        .arg(path)
        .spawn()
        .map(|_| ())
}

#[cfg(not(target_os = "macos"))]
fn quick_look(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Quick Look is only available on macOS.",
    ))
}

#[cfg(target_os = "macos")]
fn get_finder_tags(path: &Path) -> io::Result<Vec<String>> {
    let output = Command::new("mdls")
        .args(["-name", "kMDItemUserTags", "-raw"])
        .arg(path)
        .output()?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .split(',')
        .map(|value| value.trim().trim_matches('"').to_string())
        .filter(|value| !value.is_empty() && value != "null")
        .collect())
}

#[cfg(not(target_os = "macos"))]
fn get_finder_tags(_path: &Path) -> io::Result<Vec<String>> {
    Ok(Vec::new())
}

#[cfg(target_os = "macos")]
fn set_finder_tags(path: &Path, tags: &[String]) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid path"))?;
    let attr_name = CString::new("com.apple.metadata:_kMDItemUserTags").unwrap();
    if tags.is_empty() {
        let result =
            unsafe { libc::removexattr(c_path.as_ptr(), attr_name.as_ptr(), libc::XATTR_NOFOLLOW) };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ENOATTR) {
            Ok(())
        } else {
            Err(error)
        };
    }
    let escaped = tags
        .iter()
        .map(|tag| {
            format!(
                "<string>{}</string>",
                tag.replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><array>{escaped}</array></plist>"
    );
    let temp = std::env::temp_dir().join(format!(
        "explorie-tags-{}-{}.plist",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    fs::write(&temp, plist)?;
    let converted = Command::new("plutil")
        .args(["-convert", "binary1"])
        .arg(&temp)
        .status()?;
    if !converted.success() {
        let _ = fs::remove_file(&temp);
        return Err(io::Error::other("Failed to convert Finder tag plist"));
    }
    let binary = fs::read(&temp);
    let _ = fs::remove_file(&temp);
    let binary = binary?;
    let result = unsafe {
        libc::setxattr(
            c_path.as_ptr(),
            attr_name.as_ptr(),
            binary.as_ptr().cast(),
            binary.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
fn set_finder_tags(_path: &Path, _tags: &[String]) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Finder tags are only available on macOS.",
    ))
}

fn finder_tag_colors() -> HashMap<String, u8> {
    [
        ("None", 0),
        ("Gray", 1),
        ("Green", 2),
        ("Purple", 3),
        ("Blue", 4),
        ("Yellow", 5),
        ("Red", 6),
        ("Orange", 7),
    ]
    .into_iter()
    .map(|(name, color)| (name.to_string(), color))
    .collect()
}

#[cfg(target_os = "macos")]
fn open_with_app(path: &Path, app_name: &str) -> io::Result<()> {
    Command::new("open")
        .args(["-a", app_name])
        .arg(path)
        .spawn()
        .map(|_| ())
}

#[cfg(windows)]
fn open_with_app(path: &Path, _app_name: &str) -> io::Result<()> {
    Command::new("rundll32.exe")
        .args(["shell32.dll,OpenAs_RunDLL"])
        .arg(path)
        .spawn()
        .map(|_| ())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open_with_app(_path: &Path, _app_name: &str) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Open With is unavailable on this platform.",
    ))
}

#[cfg(target_os = "macos")]
fn apps_for_file(path: &Path) -> io::Result<Vec<AppInfo>> {
    use std::collections::HashSet;
    let output = Command::new("mdls")
        .args(["-name", "kMDItemContentType", "-raw"])
        .arg(path)
        .output()?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let uti = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if uti.is_empty() || uti == "(null)" {
        return Ok(Vec::new());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let common: &[(&str, &str)] = match extension.as_str() {
        "txt" | "md" | "json" | "js" | "ts" | "py" | "rs" | "go" | "html" | "css" => &[
            ("TextEdit", "/System/Applications/TextEdit.app"),
            ("Visual Studio Code", "/Applications/Visual Studio Code.app"),
            ("Sublime Text", "/Applications/Sublime Text.app"),
            ("BBEdit", "/Applications/BBEdit.app"),
            ("Xcode", "/Applications/Xcode.app"),
        ],
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "heic" => &[
            ("Preview", "/System/Applications/Preview.app"),
            ("Photos", "/System/Applications/Photos.app"),
            ("Pixelmator Pro", "/Applications/Pixelmator Pro.app"),
        ],
        "pdf" => &[("Preview", "/System/Applications/Preview.app")],
        "mp4" | "mov" | "avi" | "mkv" | "webm" => &[
            (
                "QuickTime Player",
                "/System/Applications/QuickTime Player.app",
            ),
            ("VLC", "/Applications/VLC.app"),
            ("IINA", "/Applications/IINA.app"),
        ],
        _ => &[],
    };
    let mut seen = HashSet::new();
    Ok(common
        .iter()
        .filter_map(|(name, app_path)| {
            let path = Path::new(app_path);
            (path.exists() && seen.insert(*name)).then(|| AppInfo {
                name: (*name).to_string(),
                path: path.to_path_buf(),
                bundle_id: None,
            })
        })
        .collect())
}

#[cfg(windows)]
fn apps_for_file(_path: &Path) -> io::Result<Vec<AppInfo>> {
    Ok(vec![AppInfo {
        name: "Choose another app…".to_string(),
        path: PathBuf::new(),
        bundle_id: None,
    }])
}

#[cfg(not(any(windows, target_os = "macos")))]
fn apps_for_file(_path: &Path) -> io::Result<Vec<AppInfo>> {
    Ok(Vec::new())
}

#[cfg(windows)]
mod windows_integration {
    use super::*;
    use std::os::windows::process::CommandExt;

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
                    &format!(r#""{}" "{}""#, executable.display(), path_argument),
                )
            })();
            if let Err(error) = result {
                let _ = remove();
                return Err(error);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NativeServices, ResourcePaths};
    use std::fs;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeFinderTagsBackend(Mutex<Vec<String>>);

    #[derive(Default)]
    struct FakePlatformActionsBackend {
        calls: Mutex<Vec<String>>,
        fail_next: Mutex<Option<&'static str>>,
    }

    impl FakePlatformActionsBackend {
        fn record(&self, action: &'static str, path: &Path) -> io::Result<()> {
            if self.fail_next.lock().unwrap().take() == Some(action) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("fake {action} denied"),
                ));
            }
            self.calls
                .lock()
                .unwrap()
                .push(format!("{action}:{}", path.display()));
            Ok(())
        }
    }

    impl FinderTagsBackend for FakeFinderTagsBackend {
        fn supported(&self) -> bool {
            true
        }

        fn get(&self, _path: &Path) -> io::Result<Vec<String>> {
            Ok(self.0.lock().unwrap().clone())
        }

        fn set(&self, _path: &Path, tags: &[String]) -> io::Result<()> {
            *self.0.lock().unwrap() = tags.to_vec();
            Ok(())
        }
    }

    impl PlatformActionsBackend for FakePlatformActionsBackend {
        fn open(&self, path: &Path) -> io::Result<()> {
            self.record("open", path)
        }

        fn reveal(&self, path: &Path) -> io::Result<()> {
            self.record("reveal", path)
        }

        fn quick_look(&self, path: &Path) -> io::Result<()> {
            self.record("quick_look", path)
        }

        fn open_with(&self, path: &Path, app_name: &str) -> io::Result<()> {
            self.record("open_with", path)?;
            self.calls.lock().unwrap().push(format!("app:{app_name}"));
            Ok(())
        }

        fn apps_for_file(&self, path: &Path) -> io::Result<Vec<AppInfo>> {
            self.record("apps_for_file", path)?;
            Ok(vec![AppInfo {
                name: "Fixture App".to_string(),
                path: PathBuf::from("/fixture/app"),
                bundle_id: Some("test.fixture.app".to_string()),
            }])
        }
    }

    #[test]
    fn finder_tag_colors_are_stable_on_all_platforms() {
        let colors = finder_tag_colors();
        assert_eq!(colors.get("None"), Some(&0));
        assert_eq!(colors.get("Orange"), Some(&7));
    }

    #[test]
    fn platform_and_home_are_exposed_by_native_adapter() {
        let root = tempfile::tempdir().unwrap();
        let native = NativeServices::new(ResourcePaths::test(root.path()));
        let service = native.integration.clone();
        assert!(!service.platform().is_empty());
        assert!(service.app_version().is_empty());
        let _ = NativeServices::new(ResourcePaths::test(root.path()));
    }

    #[test]
    fn injected_finder_tags_backend_crosses_the_async_service_boundary() {
        let root = tempfile::tempdir().unwrap();
        let backend = Arc::new(FakeFinderTagsBackend::default());
        backend.0.lock().unwrap().push("Important\n6".to_string());
        let native = NativeServices::with_finder_tags_backend(
            ResourcePaths::test(root.path()),
            backend.clone(),
        );
        assert!(native.integration.finder_tags_supported());
        assert_eq!(
            native
                .integration
                .finder_tags(root.path().join("fixture.txt"))
                .wait()
                .unwrap(),
            vec!["Important\n6".to_string()]
        );
        native
            .integration
            .set_finder_tags(
                root.path().join("fixture.txt"),
                vec!["Review\n4".to_string()],
            )
            .wait()
            .unwrap();
        assert_eq!(*backend.0.lock().unwrap(), vec!["Review\n4".to_string()]);
    }

    #[test]
    fn injected_platform_actions_cross_the_async_service_boundary_and_preserve_errors() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("fixture.txt");
        let backend = Arc::new(FakePlatformActionsBackend::default());
        let native = NativeServices::with_platform_actions_backend(
            ResourcePaths::test(root.path()),
            backend.clone(),
        );

        native.integration.open(path.clone()).wait().unwrap();
        native.integration.reveal(path.clone()).wait().unwrap();
        native.integration.quick_look(path.clone()).wait().unwrap();
        native
            .integration
            .open_with(path.clone(), "Fixture App".to_string())
            .wait()
            .unwrap();
        let apps = native
            .integration
            .apps_for_file(path.clone())
            .wait()
            .unwrap();
        assert_eq!(apps[0].bundle_id.as_deref(), Some("test.fixture.app"));
        let calls = backend.calls.lock().unwrap();
        assert_eq!(calls.len(), 6);
        assert!(calls[0].starts_with("open:"));
        assert!(calls[1].starts_with("reveal:"));
        assert!(calls[2].starts_with("quick_look:"));
        assert!(calls[3].starts_with("open_with:"));
        assert_eq!(calls[4], "app:Fixture App");
        assert!(calls[5].starts_with("apps_for_file:"));
        drop(calls);

        *backend.fail_next.lock().unwrap() = Some("reveal");
        let error = native.integration.reveal(path).wait().unwrap_err();
        assert_eq!(error.code, ErrorCode::PermissionDenied);
        assert_eq!(error.operation.as_deref(), Some("reveal"));
        assert!(error.message.contains("fake reveal denied"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_system_open_produces_a_real_shell_side_effect() {
        use std::thread;
        use std::time::{Duration, Instant};

        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("opened.txt");
        let script = root.path().join("open-side-effect.cmd");
        fs::write(
            &script,
            format!(
                "@echo off\r\n>\"{}\" echo opened-by-shell\r\n",
                marker.display()
            ),
        )
        .unwrap();
        let native = NativeServices::new(ResourcePaths::test(root.path()));
        native.integration.open(script).wait().unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(
            fs::read_to_string(marker).unwrap().trim(),
            "opened-by-shell"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_finder_tag_write_and_clear_preserve_source_content() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tagged.txt");
        fs::write(&path, "source stays unchanged").unwrap();
        set_finder_tags(&path, &["Review\n4".to_string()]).unwrap();

        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
        let attr_name = CString::new("com.apple.metadata:_kMDItemUserTags").unwrap();
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
        assert!(size > 0, "Finder tag xattr should contain a binary plist");

        set_finder_tags(&path, &[]).unwrap();
        let cleared = unsafe {
            libc::getxattr(
                c_path.as_ptr(),
                attr_name.as_ptr(),
                std::ptr::null_mut(),
                0,
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        assert_eq!(cleared, -1);
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ENOATTR)
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "source stays unchanged");
    }
}
