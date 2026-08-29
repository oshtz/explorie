#[cfg(target_os = "macos")]
use crate::process::{ProcessError, run_with_timeout};
use crate::{BlockingTask, ErrorCode, ServiceContext, ServiceError, ServiceResult};
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[cfg(target_os = "macos")]
use std::thread;
use std::time::Duration;

const RELEASE_API_URL: &str = "https://api.github.com/repos/oshtz/explorie/releases/latest";
const RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/oshtz/explorie/releases/download";
const WINDOWS_CHECKSUM_ASSET: &str = "SHA256SUMS-windows.txt";
const MACOS_CHECKSUM_ASSET: &str = "SHA256SUMS-macos.txt";
const MAX_RELEASE_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;
const MIN_UPDATE_BYTES: u64 = 1024 * 1024;
#[cfg(any(windows, test))]
const WINDOWS_INSTALLER_ARGUMENTS: [&str; 6] = [
    "/SP-",
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/CLOSEAPPLICATIONS",
    "/RELAUNCHEXPLORIE",
];
#[cfg(target_os = "macos")]
const MACOS_UPDATE_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(target_os = "macos")]
const MAX_MACOS_UPDATE_COMMAND_OUTPUT: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UpdatePlatform {
    Windows,
    Macos,
}

impl UpdatePlatform {
    fn current() -> Option<Self> {
        if cfg!(windows) {
            Some(Self::Windows)
        } else if cfg!(target_os = "macos") {
            Some(Self::Macos)
        } else {
            None
        }
    }

    fn asset_name(self, version: &str) -> String {
        match self {
            Self::Windows => windows_installer_name(version),
            Self::Macos => macos_dmg_name(version),
        }
    }

    fn checksum_asset(self) -> &'static str {
        match self {
            Self::Windows => WINDOWS_CHECKSUM_ASSET,
            Self::Macos => MACOS_CHECKSUM_ASSET,
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::Windows => "Windows installer",
            Self::Macos => "macOS disk image",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub asset_name: String,
    pub download_url: String,
    pub checksum_url: String,
    pub size: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DownloadedUpdate {
    pub info: UpdateInfo,
    pub installer_path: PathBuf,
    pub sha256: String,
}

#[derive(Clone)]
pub struct UpdateService {
    context: ServiceContext,
}

impl UpdateService {
    pub(crate) fn new(context: ServiceContext) -> Self {
        Self { context }
    }

    pub fn check(&self) -> BlockingTask<Option<UpdateInfo>> {
        let current_version = self.context.resources().app_version.clone();
        self.context.spawn_blocking(move || {
            let Some(platform) = UpdatePlatform::current() else {
                return Ok(None);
            };
            let release = get_bytes(RELEASE_API_URL, MAX_RELEASE_METADATA_BYTES, true)?;
            discover_update(&current_version, &release, platform)
        })
    }

    pub fn download(&self, update: UpdateInfo) -> BlockingTask<DownloadedUpdate> {
        let cache_dir = self.context.resources().cache_dir.join("updates");
        self.context.spawn_blocking(move || {
            validate_update_info(&update)?;
            fs::create_dir_all(&cache_dir).map_err(ServiceError::from)?;

            let manifest = get_bytes(&update.checksum_url, MAX_MANIFEST_BYTES, false)?;
            let manifest = std::str::from_utf8(&manifest).map_err(|_| {
                ServiceError::new(
                    ErrorCode::InvalidInput,
                    "The update checksum manifest is not valid UTF-8",
                )
            })?;
            let expected_sha256 = checksum_for_asset(manifest, &update.asset_name)?;
            let installer_path = cache_dir.join(&update.asset_name);
            if installer_path.is_file()
                && hash_file(&installer_path)? == expected_sha256
                && installer_path
                    .metadata()
                    .map(|value| value.len())
                    .unwrap_or(0)
                    == update.size
            {
                return Ok(DownloadedUpdate {
                    info: update,
                    installer_path,
                    sha256: expected_sha256,
                });
            }

            let staged_path = cache_dir.join(format!("{}.part", update.asset_name));
            let _ = fs::remove_file(&staged_path);
            let result = download_installer(
                &update.download_url,
                &staged_path,
                update.size,
                &expected_sha256,
            );
            if let Err(error) = result {
                let _ = fs::remove_file(&staged_path);
                return Err(error);
            }
            if installer_path.exists() {
                fs::remove_file(&installer_path).map_err(ServiceError::from)?;
            }
            fs::rename(&staged_path, &installer_path).map_err(ServiceError::from)?;

            Ok(DownloadedUpdate {
                info: update,
                installer_path,
                sha256: expected_sha256,
            })
        })
    }

    pub fn launch(&self, update: DownloadedUpdate) -> BlockingTask<()> {
        let cache_dir = self.context.resources().cache_dir.join("updates");
        #[cfg(target_os = "macos")]
        let resources = self.context.resources().clone();
        self.context.spawn_blocking(move || {
            validate_downloaded_update(&cache_dir, &update)?;
            #[cfg(windows)]
            return launch_installer(&update.installer_path);
            #[cfg(target_os = "macos")]
            return launch_macos_update_helper(&resources, &update);
            #[cfg(not(any(windows, target_os = "macos")))]
            Err(ServiceError::new(
                ErrorCode::Unsupported,
                "Automatic updates are unavailable on this platform",
            ))
        })
    }
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    body: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

fn discover_update(
    current_version: &str,
    release_json: &[u8],
    platform: UpdatePlatform,
) -> ServiceResult<Option<UpdateInfo>> {
    let current = Version::parse(current_version).map_err(|_| {
        ServiceError::new(
            ErrorCode::InvalidInput,
            "The installed Explorie version is not valid semantic version data",
        )
    })?;
    let release: GitHubRelease = serde_json::from_slice(release_json).map_err(|_| {
        ServiceError::new(
            ErrorCode::RemoteUnavailable,
            "GitHub returned malformed release metadata",
        )
        .retryable(true)
    })?;
    let version_text = release.tag_name.strip_prefix('v').ok_or_else(|| {
        ServiceError::new(
            ErrorCode::InvalidInput,
            "The latest Explorie release tag is malformed",
        )
    })?;
    let version = Version::parse(version_text).map_err(|_| {
        ServiceError::new(
            ErrorCode::InvalidInput,
            "The latest Explorie release version is malformed",
        )
    })?;
    if version <= current {
        return Ok(None);
    }

    let asset_name = platform.asset_name(version_text);
    let installer = release
        .assets
        .iter()
        .find(|asset| asset.name == asset_name)
        .ok_or_else(|| {
            ServiceError::new(
                ErrorCode::NotFound,
                format!(
                    "Release v{version_text} has no compatible {}",
                    platform.display_name()
                ),
            )
        })?;
    if !(MIN_UPDATE_BYTES..=MAX_UPDATE_BYTES).contains(&installer.size) {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The update payload has an invalid size",
        ));
    }
    let checksum = release
        .assets
        .iter()
        .find(|asset| asset.name == platform.checksum_asset())
        .ok_or_else(|| {
            ServiceError::new(
                ErrorCode::NotFound,
                format!(
                    "The {} update checksum manifest is missing",
                    platform.display_name()
                ),
            )
        })?;

    let update = UpdateInfo {
        version: version_text.to_string(),
        notes: release.body.filter(|body| !body.trim().is_empty()),
        asset_name,
        download_url: installer.browser_download_url.clone(),
        checksum_url: checksum.browser_download_url.clone(),
        size: installer.size,
    };
    validate_update_info_for_platform(&update, platform)?;
    Ok(Some(update))
}

fn validate_update_info(update: &UpdateInfo) -> ServiceResult<()> {
    let platform = UpdatePlatform::current().ok_or_else(|| {
        ServiceError::new(
            ErrorCode::Unsupported,
            "Automatic updates are unavailable on this platform",
        )
    })?;
    validate_update_info_for_platform(update, platform)
}

fn validate_update_info_for_platform(
    update: &UpdateInfo,
    platform: UpdatePlatform,
) -> ServiceResult<()> {
    if Version::parse(&update.version).is_err() {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The update version is malformed",
        ));
    }
    let expected_asset = platform.asset_name(&update.version);
    if update.asset_name != expected_asset
        || update.download_url != release_asset_url(&update.version, &expected_asset)
        || update.checksum_url != release_asset_url(&update.version, platform.checksum_asset())
        || !(MIN_UPDATE_BYTES..=MAX_UPDATE_BYTES).contains(&update.size)
    {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The update metadata does not match the Explorie release contract",
        ));
    }
    Ok(())
}

fn windows_installer_name(version: &str) -> String {
    format!("explorie-{version}-windows-x64-setup-unsigned.exe")
}

fn macos_dmg_name(version: &str) -> String {
    format!("explorie-{version}-macos-arm64.dmg")
}

fn release_asset_url(version: &str, asset_name: &str) -> String {
    format!("{RELEASE_DOWNLOAD_PREFIX}/v{version}/{asset_name}")
}

fn checksum_for_asset(manifest: &str, asset_name: &str) -> ServiceResult<String> {
    let mut matches = manifest.lines().filter_map(|line| {
        let (hash, name) = line.trim().split_once(char::is_whitespace)?;
        let name = name.trim_start().trim_start_matches('*');
        (name == asset_name).then_some(hash)
    });
    let Some(hash) = matches.next() else {
        return Err(ServiceError::new(
            ErrorCode::NotFound,
            "The update payload is not covered by its checksum manifest",
        ));
    };
    if matches.next().is_some()
        || hash.len() != 64
        || !hash.bytes().all(|value| value.is_ascii_hexdigit())
    {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The update checksum manifest is malformed",
        ));
    }
    Ok(hash.to_ascii_lowercase())
}

fn get_bytes(url: &str, limit: u64, github_api: bool) -> ServiceResult<Vec<u8>> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .timeout_write(Duration::from_secs(30))
        .build();
    let mut request = agent.get(url).set("User-Agent", "explorie-updater");
    if github_api {
        request = request.set("Accept", "application/vnd.github+json");
    }
    let response = request.call().map_err(network_error)?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(ServiceError::from)?;
    if bytes.len() as u64 > limit {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The update response exceeded its safety limit",
        ));
    }
    Ok(bytes)
}

fn download_installer(
    url: &str,
    path: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> ServiceResult<()> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(60))
        .timeout_write(Duration::from_secs(30))
        .build();
    let response = agent
        .get(url)
        .set("User-Agent", "explorie-updater")
        .call()
        .map_err(network_error)?;
    let mut reader = response.into_reader();
    let mut file = File::create(path).map_err(ServiceError::from)?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = reader.read(&mut buffer).map_err(ServiceError::from)?;
        if count == 0 {
            break;
        }
        total = total.saturating_add(count as u64);
        if total > MAX_UPDATE_BYTES || total > expected_size {
            return Err(ServiceError::new(
                ErrorCode::InvalidInput,
                "The update payload exceeded its declared size",
            ));
        }
        hasher.update(&buffer[..count]);
        file.write_all(&buffer[..count])
            .map_err(ServiceError::from)?;
    }
    file.sync_all().map_err(ServiceError::from)?;
    if total != expected_size {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The update payload size does not match its release metadata",
        ));
    }
    let actual_sha256 = format!("{:x}", hasher.finalize());
    if actual_sha256 != expected_sha256 {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The update payload failed its SHA-256 integrity check",
        ));
    }
    Ok(())
}

fn hash_file(path: &Path) -> ServiceResult<String> {
    let mut file = File::open(path).map_err(ServiceError::from)?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher).map_err(ServiceError::from)?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_downloaded_update(cache_dir: &Path, update: &DownloadedUpdate) -> ServiceResult<()> {
    let platform = UpdatePlatform::current().ok_or_else(|| {
        ServiceError::new(
            ErrorCode::Unsupported,
            "Automatic updates are unavailable on this platform",
        )
    })?;
    validate_downloaded_update_for_platform(cache_dir, update, platform)
}

fn validate_downloaded_update_for_platform(
    cache_dir: &Path,
    update: &DownloadedUpdate,
    platform: UpdatePlatform,
) -> ServiceResult<()> {
    validate_update_info_for_platform(&update.info, platform)?;
    let expected_path = cache_dir.join(&update.info.asset_name);
    if update.installer_path != expected_path || !expected_path.is_file() {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The prepared update is outside the Explorie update cache",
        ));
    }
    let actual_sha256 = hash_file(&expected_path)?;
    if expected_path
        .metadata()
        .map(|value| value.len())
        .unwrap_or(0)
        != update.info.size
        || actual_sha256 != update.sha256
    {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The prepared update changed after verification",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn launch_installer(installer: &Path) -> ServiceResult<()> {
    let mut command = Command::new(installer);
    command
        .args(WINDOWS_INSTALLER_ARGUMENTS)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map(|_| ()).map_err(|error| {
        ServiceError::from(error)
            .operation("launch_update")
            .retryable(true)
    })
}

#[cfg(target_os = "macos")]
fn launch_macos_update_helper(
    resources: &crate::ResourcePaths,
    update: &DownloadedUpdate,
) -> ServiceResult<()> {
    let current_exe = resources.current_exe.as_deref().ok_or_else(|| {
        ServiceError::new(
            ErrorCode::NotFound,
            "The installed Explorie executable could not be located",
        )
    })?;
    macos_installed_app_bundle(current_exe)?;
    let mut command = Command::new(current_exe);
    command
        .arg("--apply-macos-update")
        .arg(&update.installer_path)
        .arg(&update.info.version)
        .arg(&update.sha256)
        .arg(update.info.size.to_string())
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn().map(|_| ()).map_err(|error| {
        ServiceError::from(error)
            .operation("launch_update")
            .retryable(true)
    })
}

#[cfg(target_os = "macos")]
pub fn apply_macos_update_command(
    args: impl IntoIterator<Item = OsString>,
) -> Option<ServiceResult<()>> {
    let mut args = args.into_iter().skip(1);
    while let Some(argument) = args.next() {
        if argument != "--apply-macos-update" {
            continue;
        }
        let reopen_app = std::env::current_exe()
            .ok()
            .and_then(|current_exe| macos_installed_app_bundle(&current_exe).ok());
        let parsed = (|| {
            let payload = PathBuf::from(args.next().ok_or_else(|| {
                ServiceError::new(
                    ErrorCode::InvalidInput,
                    "The update payload path is missing",
                )
            })?);
            let version = os_string_argument(args.next(), "update version")?;
            let sha256 = os_string_argument(args.next(), "update checksum")?;
            let size = os_string_argument(args.next(), "update size")?
                .parse::<u64>()
                .map_err(|_| {
                    ServiceError::new(ErrorCode::InvalidInput, "The update size is malformed")
                })?;
            let parent_pid = os_string_argument(args.next(), "parent process")?
                .parse::<u32>()
                .map_err(|_| {
                    ServiceError::new(
                        ErrorCode::InvalidInput,
                        "The update parent process is malformed",
                    )
                })?;
            apply_macos_update(payload, version, sha256, size, parent_pid)
        })();
        if parsed.is_err()
            && let Some(app) = reopen_app
            && app.is_dir()
        {
            let _ = open_macos_app(&app);
        }
        return Some(parsed);
    }
    None
}

#[cfg(target_os = "macos")]
fn os_string_argument(value: Option<OsString>, label: &str) -> ServiceResult<String> {
    value
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| {
            ServiceError::new(ErrorCode::InvalidInput, format!("The {label} is missing"))
        })
}

#[cfg(target_os = "macos")]
fn apply_macos_update(
    payload: PathBuf,
    version: String,
    sha256: String,
    size: u64,
    parent_pid: u32,
) -> ServiceResult<()> {
    let current_exe = std::env::current_exe().map_err(ServiceError::from)?;
    let target_app = macos_installed_app_bundle(&current_exe)?;
    wait_for_process_exit(parent_pid)?;

    let cache_dir = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("explorie/updates");
    let info = UpdateInfo {
        version: version.clone(),
        notes: None,
        asset_name: macos_dmg_name(&version),
        download_url: release_asset_url(&version, &macos_dmg_name(&version)),
        checksum_url: release_asset_url(&version, MACOS_CHECKSUM_ASSET),
        size,
    };
    let update = DownloadedUpdate {
        info,
        installer_path: payload.clone(),
        sha256,
    };
    validate_downloaded_update(&cache_dir, &update)?;

    let old_team = verify_macos_app(&target_app, None, None)?;
    run_macos_command(
        Command::new("/usr/bin/hdiutil").arg("verify").arg(&payload),
        "The downloaded update disk image is invalid",
    )?;
    run_macos_command(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--verbose=2"])
            .arg(&payload),
        "The downloaded update disk image has an invalid signature",
    )?;
    run_macos_command(
        Command::new("/usr/sbin/spctl")
            .args([
                "--assess",
                "--type",
                "open",
                "--context",
                "context:primary-signature",
                "--verbose=2",
            ])
            .arg(&payload),
        "Gatekeeper rejected the downloaded update disk image",
    )?;

    let mut mounted = MountedUpdate::attach(&payload)?;
    let source_app = find_mounted_update_app(&mounted.mount_point)?;
    verify_macos_app(&source_app, Some(&version), Some(&old_team))?;

    let parent = target_app.parent().ok_or_else(|| {
        ServiceError::new(
            ErrorCode::InvalidInput,
            "The installed Explorie application has no parent directory",
        )
    })?;
    let nonce = uuid::Uuid::new_v4();
    let staged_app = parent.join(format!(".explorie-update-{nonce}.app"));
    let backup_app = parent.join(format!(".explorie-backup-{nonce}.app"));
    if let Err(error) = run_macos_command(
        Command::new("/usr/bin/ditto")
            .arg(&source_app)
            .arg(&staged_app),
        "Unable to stage the Explorie update",
    ) {
        let _ = fs::remove_dir_all(&staged_app);
        return Err(error);
    }
    if let Err(error) = verify_macos_app(&staged_app, Some(&version), Some(&old_team)) {
        let _ = fs::remove_dir_all(&staged_app);
        return Err(error);
    }
    if let Err(error) = mounted.detach() {
        let _ = fs::remove_dir_all(&staged_app);
        return Err(error);
    }

    if let Err(error) = fs::rename(&target_app, &backup_app) {
        let _ = fs::remove_dir_all(&staged_app);
        return Err(ServiceError::from(error)
            .operation("backup_installed_update")
            .retryable(true));
    }
    if let Err(error) = fs::rename(&staged_app, &target_app) {
        if let Err(restore_error) = fs::rename(&backup_app, &target_app) {
            return Err(ServiceError::new(
                ErrorCode::Io,
                format!(
                    "The update replacement failed and rollback failed: {error}; {restore_error}"
                ),
            ));
        }
        let _ = fs::remove_dir_all(&staged_app);
        return Err(ServiceError::from(error)
            .operation("replace_installed_update")
            .retryable(true));
    }

    if let Err(error) = open_macos_app(&target_app) {
        fs::remove_dir_all(&target_app).map_err(|remove_error| {
            ServiceError::new(
                ErrorCode::Io,
                format!(
                    "The update could not reopen and its staged app could not be removed: {error}; {remove_error}"
                ),
            )
        })?;
        fs::rename(&backup_app, &target_app).map_err(|restore_error| {
            ServiceError::new(
                ErrorCode::Io,
                format!(
                    "The update could not reopen and rollback failed: {error}; {restore_error}"
                ),
            )
        })?;
        let _ = open_macos_app(&target_app);
        return Err(error);
    }

    remove_directory_with_retries(&backup_app);
    remove_file_with_retries(&payload);
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_installed_app_bundle(current_exe: &Path) -> ServiceResult<PathBuf> {
    let app = current_exe
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .ok_or_else(|| {
            ServiceError::new(
                ErrorCode::InvalidInput,
                "Automatic updates require an installed Explorie application bundle",
            )
        })?;
    let installed_roots = [
        PathBuf::from("/Applications"),
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join("Applications"),
    ];
    if !installed_roots.iter().any(|root| app.starts_with(root))
        || !app.is_dir()
        || fs::symlink_metadata(app)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(true)
    {
        return Err(ServiceError::new(
            ErrorCode::PermissionDenied,
            "Move Explorie to Applications before installing updates",
        ));
    }
    Ok(app.to_path_buf())
}

#[cfg(target_os = "macos")]
fn wait_for_process_exit(parent_pid: u32) -> ServiceResult<()> {
    if parent_pid == 0 {
        return Ok(());
    }
    for _ in 0..240 {
        // SAFETY: Signal zero checks whether the specified process still exists
        // without delivering a signal or changing process state.
        let status = unsafe { libc::kill(parent_pid as libc::pid_t, 0) };
        if status != 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(ServiceError::new(
        ErrorCode::Busy,
        "Explorie did not finish closing before the update timeout",
    )
    .retryable(true))
}

#[cfg(target_os = "macos")]
fn verify_macos_app(
    app: &Path,
    expected_version: Option<&str>,
    expected_team: Option<&str>,
) -> ServiceResult<String> {
    let plist = fs::read_to_string(app.join("Contents/Info.plist")).map_err(ServiceError::from)?;
    if !plist.contains("<string>com.omershatz.explorie</string>") {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The update application has an unexpected bundle identifier",
        ));
    }
    if let Some(version) = expected_version {
        let expected = format!("<key>CFBundleShortVersionString</key><string>{version}</string>");
        if !plist.contains(&expected) {
            return Err(ServiceError::new(
                ErrorCode::InvalidInput,
                "The update application version does not match the release",
            ));
        }
    }
    run_macos_command(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict", "--verbose=2"])
            .arg(app),
        "The update application has an invalid code signature",
    )?;
    run_macos_command(
        Command::new("/usr/sbin/spctl")
            .args(["--assess", "--type", "execute", "--verbose=2"])
            .arg(app),
        "Gatekeeper rejected the update application",
    )?;
    let details = run_macos_command(
        Command::new("/usr/bin/codesign")
            .args(["-d", "--verbose=4"])
            .arg(app),
        "Unable to inspect the update application signature",
    )?;
    let details = String::from_utf8_lossy(&details);
    let team = details
        .lines()
        .find_map(|line| line.trim().strip_prefix("TeamIdentifier="))
        .filter(|team| !team.is_empty() && *team != "not set")
        .ok_or_else(|| {
            ServiceError::new(
                ErrorCode::InvalidInput,
                "The update application has no Developer ID team identifier",
            )
        })?;
    if expected_team.is_some_and(|expected| expected != team) {
        return Err(ServiceError::new(
            ErrorCode::PermissionDenied,
            "The update application was signed by a different developer team",
        ));
    }
    Ok(team.to_string())
}

#[cfg(target_os = "macos")]
fn find_mounted_update_app(mount_point: &Path) -> ServiceResult<PathBuf> {
    let mut apps = fs::read_dir(mount_point)
        .map_err(ServiceError::from)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "app"));
    let app = apps.next().ok_or_else(|| {
        ServiceError::new(
            ErrorCode::NotFound,
            "The update disk image contains no application bundle",
        )
    })?;
    if apps.next().is_some() {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The update disk image contains multiple application bundles",
        ));
    }
    Ok(app)
}

#[cfg(target_os = "macos")]
struct MountedUpdate {
    mount_point: PathBuf,
    attached: bool,
}

#[cfg(target_os = "macos")]
impl MountedUpdate {
    fn attach(payload: &Path) -> ServiceResult<Self> {
        let mount_point = std::env::temp_dir().join(format!(
            "explorie-update-mount-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&mount_point).map_err(ServiceError::from)?;
        let attached = run_macos_command(
            Command::new("/usr/bin/hdiutil")
                .args(["attach", "-nobrowse", "-readonly", "-mountpoint"])
                .arg(&mount_point)
                .arg(payload),
            "Unable to mount the update disk image",
        );
        if let Err(error) = attached {
            let _ = fs::remove_dir(&mount_point);
            return Err(error);
        }
        Ok(Self {
            mount_point,
            attached: true,
        })
    }

    fn detach(&mut self) -> ServiceResult<()> {
        if self.attached {
            run_macos_command(
                Command::new("/usr/bin/hdiutil")
                    .arg("detach")
                    .arg(&self.mount_point),
                "Unable to unmount the update disk image",
            )?;
            self.attached = false;
        }
        let _ = fs::remove_dir(&self.mount_point);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
impl Drop for MountedUpdate {
    fn drop(&mut self) {
        if self.attached {
            let _ = Command::new("/usr/bin/hdiutil")
                .arg("detach")
                .arg(&self.mount_point)
                .status();
        }
        let _ = fs::remove_dir(&self.mount_point);
    }
}

#[cfg(target_os = "macos")]
fn run_macos_command(command: &mut Command, message: &str) -> ServiceResult<Vec<u8>> {
    let output = run_with_timeout(
        command,
        MACOS_UPDATE_COMMAND_TIMEOUT,
        MAX_MACOS_UPDATE_COMMAND_OUTPUT,
        MAX_MACOS_UPDATE_COMMAND_OUTPUT,
    )
    .map_err(|error| match error {
        ProcessError::Io(error) => ServiceError::from(error),
        ProcessError::TimedOut => ServiceError::new(
            ErrorCode::Busy,
            format!("{message}: the system command timed out"),
        )
        .retryable(true),
    })?;
    if output.status.success() {
        let mut details = output.stdout;
        details.extend_from_slice(&output.stderr);
        return Ok(details);
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    Err(ServiceError::new(
        ErrorCode::PermissionDenied,
        if detail.trim().is_empty() {
            message.to_string()
        } else {
            format!("{message}: {}", detail.trim())
        },
    ))
}

#[cfg(target_os = "macos")]
fn open_macos_app(app: &Path) -> ServiceResult<()> {
    run_macos_command(
        Command::new("/usr/bin/open").args(["-n"]).arg(app),
        "Unable to reopen Explorie after updating",
    )
    .map(|_| ())
}

#[cfg(target_os = "macos")]
fn remove_directory_with_retries(path: &Path) {
    for _ in 0..120 {
        match fs::remove_dir_all(path) {
            Ok(()) => return,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return,
            Err(_) => thread::sleep(Duration::from_millis(250)),
        }
    }
}

#[cfg(target_os = "macos")]
fn remove_file_with_retries(path: &Path) {
    for _ in 0..120 {
        match fs::remove_file(path) {
            Ok(()) => return,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return,
            Err(_) => thread::sleep(Duration::from_millis(250)),
        }
    }
}

fn network_error(error: ureq::Error) -> ServiceError {
    ServiceError::new(
        ErrorCode::RemoteUnavailable,
        format!("Unable to reach the Explorie release service: {error}"),
    )
    .retryable(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release_json(
        version: &str,
        size: u64,
        asset_name: &str,
        platform: UpdatePlatform,
    ) -> Vec<u8> {
        let checksum = platform.checksum_asset();
        format!(
            r#"{{"tag_name":"v{version}","body":"Fixes","assets":[{{"name":"{asset_name}","browser_download_url":"{RELEASE_DOWNLOAD_PREFIX}/v{version}/{asset_name}","size":{size}}},{{"name":"{checksum}","browser_download_url":"{RELEASE_DOWNLOAD_PREFIX}/v{version}/{checksum}","size":100}}]}}"#
        )
        .into_bytes()
    }

    #[test]
    fn discovers_only_a_newer_exact_unsigned_installer() {
        let name = windows_installer_name("0.2.9");
        let update = discover_update(
            "0.2.8",
            &release_json("0.2.9", MIN_UPDATE_BYTES, &name, UpdatePlatform::Windows),
            UpdatePlatform::Windows,
        )
        .unwrap()
        .unwrap();
        assert_eq!(update.version, "0.2.9");
        assert_eq!(update.asset_name, name);

        assert!(
            discover_update(
                "0.2.9",
                &release_json(
                    "0.2.9",
                    MIN_UPDATE_BYTES,
                    &update.asset_name,
                    UpdatePlatform::Windows,
                ),
                UpdatePlatform::Windows,
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn discovers_the_exact_macos_dmg_and_checksum_contract() {
        let name = macos_dmg_name("0.2.9");
        let update = discover_update(
            "0.2.8",
            &release_json("0.2.9", MIN_UPDATE_BYTES, &name, UpdatePlatform::Macos),
            UpdatePlatform::Macos,
        )
        .unwrap()
        .unwrap();
        assert_eq!(update.asset_name, "explorie-0.2.9-macos-arm64.dmg");
        assert_eq!(
            update.checksum_url,
            release_asset_url("0.2.9", MACOS_CHECKSUM_ASSET)
        );

        let windows_asset = windows_installer_name("0.2.9");
        assert!(
            discover_update(
                "0.2.8",
                &release_json(
                    "0.2.9",
                    MIN_UPDATE_BYTES,
                    &windows_asset,
                    UpdatePlatform::Macos,
                ),
                UpdatePlatform::Macos,
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_portable_fallbacks_missing_checksums_and_foreign_urls() {
        let portable = "explorie-0.2.9-windows-x64-portable-unsigned.exe";
        assert!(
            discover_update(
                "0.2.8",
                &release_json("0.2.9", MIN_UPDATE_BYTES, portable, UpdatePlatform::Windows,),
                UpdatePlatform::Windows,
            )
            .is_err()
        );

        let name = windows_installer_name("0.2.9");
        let mut update = discover_update(
            "0.2.8",
            &release_json("0.2.9", MIN_UPDATE_BYTES, &name, UpdatePlatform::Windows),
            UpdatePlatform::Windows,
        )
        .unwrap()
        .unwrap();
        update.download_url = "https://example.com/update.exe".to_string();
        assert!(validate_update_info(&update).is_err());

        let no_checksum = format!(
            r#"{{"tag_name":"v0.2.9","assets":[{{"name":"{name}","browser_download_url":"{RELEASE_DOWNLOAD_PREFIX}/v0.2.9/{name}","size":{MIN_UPDATE_BYTES}}}]}}"#
        );
        assert!(
            discover_update("0.2.8", no_checksum.as_bytes(), UpdatePlatform::Windows,).is_err()
        );
    }

    #[test]
    fn checksum_manifest_requires_one_exact_valid_entry() {
        let asset = windows_installer_name("0.2.9");
        let hash = "a".repeat(64);
        assert_eq!(
            checksum_for_asset(&format!("{hash} *{asset}\n"), &asset).unwrap(),
            hash
        );
        assert!(checksum_for_asset(&format!("{hash} *other.exe\n"), &asset).is_err());
        assert!(
            checksum_for_asset(&format!("{hash} *{asset}\n{hash} *{asset}\n"), &asset).is_err()
        );
    }

    #[test]
    fn prepared_update_is_rehashed_immediately_before_launch() {
        let temp = tempfile::tempdir().unwrap();
        for platform in [UpdatePlatform::Windows, UpdatePlatform::Macos] {
            let cache = temp.path().join(platform.display_name());
            fs::create_dir_all(&cache).unwrap();
            let name = platform.asset_name("0.2.9");
            let path = cache.join(&name);
            fs::write(&path, vec![0_u8; MIN_UPDATE_BYTES as usize]).unwrap();
            let sha256 = hash_file(&path).unwrap();
            let update = DownloadedUpdate {
                info: UpdateInfo {
                    version: "0.2.9".to_string(),
                    notes: None,
                    asset_name: name.clone(),
                    download_url: release_asset_url("0.2.9", &name),
                    checksum_url: release_asset_url("0.2.9", platform.checksum_asset()),
                    size: MIN_UPDATE_BYTES,
                },
                installer_path: path.clone(),
                sha256,
            };
            assert!(validate_downloaded_update_for_platform(&cache, &update, platform).is_ok());
            fs::write(&path, b"changed update").unwrap();
            assert!(validate_downloaded_update_for_platform(&cache, &update, platform).is_err());
        }
    }

    #[test]
    fn silent_installer_arguments_request_an_app_relaunch() {
        assert!(WINDOWS_INSTALLER_ARGUMENTS.contains(&"/VERYSILENT"));
        assert!(WINDOWS_INSTALLER_ARGUMENTS.contains(&"/CLOSEAPPLICATIONS"));
        assert!(WINDOWS_INSTALLER_ARGUMENTS.contains(&"/RELAUNCHEXPLORIE"));
    }
}
