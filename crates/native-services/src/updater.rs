use crate::{BlockingTask, ErrorCode, ServiceContext, ServiceError, ServiceResult};
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const RELEASE_API_URL: &str = "https://api.github.com/repos/oshtz/explorie/releases/latest";
const RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/oshtz/explorie/releases/download";
const WINDOWS_CHECKSUM_ASSET: &str = "SHA256SUMS-windows.txt";
const MAX_RELEASE_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
const MIN_INSTALLER_BYTES: u64 = 1024 * 1024;
const WINDOWS_INSTALLER_ARGUMENTS: [&str; 6] = [
    "/SP-",
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/CLOSEAPPLICATIONS",
    "/RELAUNCHEXPLORIE",
];

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
            if !cfg!(windows) {
                return Ok(None);
            }
            let release = get_bytes(RELEASE_API_URL, MAX_RELEASE_METADATA_BYTES, true)?;
            discover_update(&current_version, &release)
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
                    "The Windows update checksum manifest is not valid UTF-8",
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
        self.context.spawn_blocking(move || {
            if !cfg!(windows) {
                return Err(ServiceError::new(
                    ErrorCode::Unsupported,
                    "Installer updates are currently available only on Windows",
                ));
            }
            validate_downloaded_update(&cache_dir, &update)?;
            launch_installer(&update.installer_path)
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

    let asset_name = windows_installer_name(version_text);
    let installer = release
        .assets
        .iter()
        .find(|asset| asset.name == asset_name)
        .ok_or_else(|| {
            ServiceError::new(
                ErrorCode::NotFound,
                format!("Release v{version_text} has no compatible Windows installer"),
            )
        })?;
    if !(MIN_INSTALLER_BYTES..=MAX_INSTALLER_BYTES).contains(&installer.size) {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The Windows update installer has an invalid size",
        ));
    }
    let checksum = release
        .assets
        .iter()
        .find(|asset| asset.name == WINDOWS_CHECKSUM_ASSET)
        .ok_or_else(|| {
            ServiceError::new(
                ErrorCode::NotFound,
                "The Windows update checksum manifest is missing",
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
    validate_update_info(&update)?;
    Ok(Some(update))
}

fn validate_update_info(update: &UpdateInfo) -> ServiceResult<()> {
    if Version::parse(&update.version).is_err() {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The Windows update version is malformed",
        ));
    }
    let expected_asset = windows_installer_name(&update.version);
    if update.asset_name != expected_asset
        || update.download_url != release_asset_url(&update.version, &expected_asset)
        || update.checksum_url != release_asset_url(&update.version, WINDOWS_CHECKSUM_ASSET)
        || !(MIN_INSTALLER_BYTES..=MAX_INSTALLER_BYTES).contains(&update.size)
    {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The Windows update metadata does not match the Explorie release contract",
        ));
    }
    Ok(())
}

fn windows_installer_name(version: &str) -> String {
    format!("explorie-{version}-windows-x64-setup-unsigned.exe")
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
            "The Windows update installer is not covered by its checksum manifest",
        ));
    };
    if matches.next().is_some()
        || hash.len() != 64
        || !hash.bytes().all(|value| value.is_ascii_hexdigit())
    {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The Windows update checksum manifest is malformed",
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
        if total > MAX_INSTALLER_BYTES || total > expected_size {
            return Err(ServiceError::new(
                ErrorCode::InvalidInput,
                "The Windows update installer exceeded its declared size",
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
            "The Windows update installer size does not match its release metadata",
        ));
    }
    let actual_sha256 = format!("{:x}", hasher.finalize());
    if actual_sha256 != expected_sha256 {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The Windows update installer failed its SHA-256 integrity check",
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
    validate_update_info(&update.info)?;
    let expected_path = cache_dir.join(&update.info.asset_name);
    if update.installer_path != expected_path || !expected_path.is_file() {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "The prepared Windows update is outside the Explorie update cache",
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
            "The prepared Windows update changed after verification",
        ));
    }
    Ok(())
}

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

    fn release_json(version: &str, size: u64, installer_name: &str) -> Vec<u8> {
        format!(
            r#"{{"tag_name":"v{version}","body":"Fixes","assets":[{{"name":"{installer_name}","browser_download_url":"{RELEASE_DOWNLOAD_PREFIX}/v{version}/{installer_name}","size":{size}}},{{"name":"{WINDOWS_CHECKSUM_ASSET}","browser_download_url":"{RELEASE_DOWNLOAD_PREFIX}/v{version}/{WINDOWS_CHECKSUM_ASSET}","size":100}}]}}"#
        )
        .into_bytes()
    }

    #[test]
    fn discovers_only_a_newer_exact_unsigned_installer() {
        let name = windows_installer_name("0.2.9");
        let update = discover_update("0.2.8", &release_json("0.2.9", MIN_INSTALLER_BYTES, &name))
            .unwrap()
            .unwrap();
        assert_eq!(update.version, "0.2.9");
        assert_eq!(update.asset_name, name);

        assert!(
            discover_update(
                "0.2.9",
                &release_json("0.2.9", MIN_INSTALLER_BYTES, &update.asset_name),
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn rejects_portable_fallbacks_missing_checksums_and_foreign_urls() {
        let portable = "explorie-0.2.9-windows-x64-portable-unsigned.exe";
        assert!(
            discover_update(
                "0.2.8",
                &release_json("0.2.9", MIN_INSTALLER_BYTES, portable),
            )
            .is_err()
        );

        let name = windows_installer_name("0.2.9");
        let mut update =
            discover_update("0.2.8", &release_json("0.2.9", MIN_INSTALLER_BYTES, &name))
                .unwrap()
                .unwrap();
        update.download_url = "https://example.com/update.exe".to_string();
        assert!(validate_update_info(&update).is_err());

        let no_checksum = format!(
            r#"{{"tag_name":"v0.2.9","assets":[{{"name":"{name}","browser_download_url":"{RELEASE_DOWNLOAD_PREFIX}/v0.2.9/{name}","size":{MIN_INSTALLER_BYTES}}}]}}"#
        );
        assert!(discover_update("0.2.8", no_checksum.as_bytes()).is_err());
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
    fn prepared_installer_is_rehashed_immediately_before_launch() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("updates");
        fs::create_dir_all(&cache).unwrap();
        let name = windows_installer_name("0.2.9");
        let path = cache.join(&name);
        fs::write(&path, vec![0_u8; MIN_INSTALLER_BYTES as usize]).unwrap();
        let sha256 = hash_file(&path).unwrap();
        let update = DownloadedUpdate {
            info: UpdateInfo {
                version: "0.2.9".to_string(),
                notes: None,
                asset_name: name.clone(),
                download_url: release_asset_url("0.2.9", &name),
                checksum_url: release_asset_url("0.2.9", WINDOWS_CHECKSUM_ASSET),
                size: MIN_INSTALLER_BYTES,
            },
            installer_path: path.clone(),
            sha256,
        };
        assert!(validate_downloaded_update(&cache, &update).is_ok());
        fs::write(path, b"changed installer").unwrap();
        assert!(validate_downloaded_update(&cache, &update).is_err());
    }

    #[test]
    fn silent_installer_arguments_request_an_app_relaunch() {
        assert!(WINDOWS_INSTALLER_ARGUMENTS.contains(&"/VERYSILENT"));
        assert!(WINDOWS_INSTALLER_ARGUMENTS.contains(&"/CLOSEAPPLICATIONS"));
        assert!(WINDOWS_INSTALLER_ARGUMENTS.contains(&"/RELAUNCHEXPLORIE"));
    }
}
