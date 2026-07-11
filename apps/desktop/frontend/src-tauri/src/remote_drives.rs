use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

#[cfg(windows)]
use sha2::{Digest, Sha256};

const READY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDriveProfile {
    pub id: String,
    pub name: String,
    pub remote: String,
    #[serde(default)]
    pub remote_path: String,
    pub mount_target: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDriveEnvironment {
    pub platform: &'static str,
    pub rclone_available: bool,
    pub rclone_version: Option<String>,
    pub winfsp_available: Option<bool>,
    pub helper_status: Option<String>,
    pub occupied_mount_targets: Vec<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDriveStatus {
    pub id: String,
    pub state: &'static str,
    pub mount_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectResult {
    pub status: RemoteDriveStatus,
    pub pending_uploads: u64,
    pub errored_files: u64,
    pub blocked: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDriveExitBlocker {
    pub pending_uploads: u64,
    pub errored_files: u64,
    pub error: Option<String>,
}

struct RunningMount {
    child: Child,
    rclone: PathBuf,
    rc_url: String,
    rc_user: String,
    rc_pass: String,
    mount_path: PathBuf,
}

#[derive(Clone, Default)]
pub struct RemoteDriveManager {
    mounts: Arc<Mutex<HashMap<String, RunningMount>>>,
}

impl RemoteDriveManager {
    pub fn environment(&self, app: &AppHandle) -> RemoteDriveEnvironment {
        let rclone = find_rclone(app);
        let version = rclone.as_ref().and_then(|path| rclone_version(path).ok());
        RemoteDriveEnvironment {
            platform: std::env::consts::OS,
            rclone_available: rclone.is_some(),
            rclone_version: version,
            winfsp_available: winfsp_available(),
            helper_status: macos_helper_status(),
            occupied_mount_targets: occupied_mount_targets(),
            error: rclone.is_none().then(missing_rclone),
        }
    }

    pub fn list_remotes(&self, app: &AppHandle) -> Result<Vec<String>, String> {
        let rclone = find_rclone(app).ok_or_else(missing_rclone)?;
        let output = Command::new(rclone)
            .args(["listremotes", "--ask-password=false"])
            .output()
            .map_err(|error| format!("Failed to run rclone: {error}"))?;
        if !output.status.success() {
            return Err(command_error(
                "rclone could not read its configuration",
                &output.stderr,
            ));
        }
        parse_remotes(&String::from_utf8_lossy(&output.stdout))
    }

    pub fn configure_remotes(&self, app: &AppHandle) -> Result<(), String> {
        let rclone = find_rclone(app).ok_or_else(missing_rclone)?;

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;

            // `start` supplies fresh console handles even when the GUI was launched from a terminal.
            let status = Command::new("cmd.exe")
                .args(["/D", "/S", "/C"])
                .raw_arg(r#"start "" /WAIT "%EXPLORIE_RCLONE%" config"#)
                .env("EXPLORIE_RCLONE", normal_windows_path(&rclone))
                .status()
                .map_err(|error| format!("Failed to open rclone configuration: {error}"))?;
            status
                .success()
                .then_some(())
                .ok_or_else(|| "rclone configuration was cancelled or failed.".to_string())
        }

        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::PermissionsExt;

            let directory = app
                .path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?
                .join("remote-drives");
            fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            let session = Uuid::new_v4().to_string();
            let script = directory.join(format!("configure-{session}.command"));
            let finished = directory.join(format!("configure-{session}.finished"));
            fs::write(
                &script,
                format!(
                    "#!/bin/zsh\n{} config\nstatus=$?\ntouch {}\nexit $status\n",
                    shell_quote(&rclone.to_string_lossy()),
                    shell_quote(&finished.to_string_lossy())
                ),
            )
            .map_err(|error| error.to_string())?;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
            let opened = Command::new("open")
                .arg(&script)
                .status()
                .map_err(|error| format!("Failed to open Terminal: {error}"))?;
            if !opened.success() {
                let _ = fs::remove_file(&script);
                return Err("Failed to open rclone configuration in Terminal.".to_string());
            }
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(30 * 60) {
                if finished.is_file() {
                    let _ = fs::remove_file(&finished);
                    let _ = fs::remove_file(&script);
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(250));
            }
            let _ = fs::remove_file(&script);
            return Err("Timed out waiting for rclone configuration to finish.".to_string());
        }

        #[cfg(not(any(windows, target_os = "macos")))]
        Err("Remote configuration currently supports Windows and macOS only.".to_string())
    }

    pub fn statuses(&self) -> Vec<RemoteDriveStatus> {
        self.mounts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter_mut()
            .map(|(id, mount)| match mount.child.try_wait() {
                Ok(Some(status)) => RemoteDriveStatus {
                    id: id.clone(),
                    state: "error",
                    mount_path: Some(mount.mount_path.to_string_lossy().into_owned()),
                    error: Some(format!("rclone exited with {status}")),
                },
                Ok(None) => RemoteDriveStatus {
                    id: id.clone(),
                    state: "connected",
                    mount_path: Some(mount.mount_path.to_string_lossy().into_owned()),
                    error: None,
                },
                Err(error) => RemoteDriveStatus {
                    id: id.clone(),
                    state: "error",
                    mount_path: Some(mount.mount_path.to_string_lossy().into_owned()),
                    error: Some(error.to_string()),
                },
            })
            .collect()
    }

    pub fn is_mount_root(&self, path: &Path) -> bool {
        let candidate = normalize_compare_path(path);
        self.mounts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .any(|mount| normalize_compare_path(&mount.mount_path) == candidate)
    }

    pub fn connect(
        &self,
        app: &AppHandle,
        profile: RemoteDriveProfile,
    ) -> Result<RemoteDriveStatus, String> {
        validate_profile(&profile)?;
        #[cfg(target_os = "macos")]
        if macos::status() != "enabled" {
            let approval = status(&profile.id, "approval-required", None, None);
            emit_status(app, approval.clone());
            return Ok(approval);
        }
        {
            let mut mounts = self
                .mounts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(existing) = mounts.get_mut(&profile.id) {
                if existing
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_none()
                {
                    return Ok(connected_status(&profile.id, &existing.mount_path));
                }
                mounts.remove(&profile.id);
            }
        }

        emit_status(app, status(&profile.id, "connecting", None, None));
        let result = self.connect_inner(app, &profile);
        match result {
            Ok(status) => {
                emit_status(app, status.clone());
                Ok(status)
            }
            Err(error) => {
                emit_status(app, status(&profile.id, "error", None, Some(error.clone())));
                Err(error)
            }
        }
    }

    fn connect_inner(
        &self,
        app: &AppHandle,
        profile: &RemoteDriveProfile,
    ) -> Result<RemoteDriveStatus, String> {
        let rclone = find_rclone(app).ok_or_else(missing_rclone)?;
        ensure_rclone_capabilities(&rclone)?;
        if !self
            .list_remotes(app)?
            .iter()
            .any(|remote| remote == &profile.remote)
        {
            return Err("The selected rclone remote is no longer configured.".to_string());
        }
        #[cfg(windows)]
        if winfsp_available() != Some(true) {
            return Err("Install WinFsp before mounting remote drives on Windows.".to_string());
        }

        let mount_path = mount_path(profile)?;
        ensure_mount_target_available(&mount_path)?;
        let cache_dir = profile_cache_dir(
            &app.path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?,
            &profile.id,
        );
        fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
        let log = File::create(cache_dir.join("rclone.log")).map_err(|error| error.to_string())?;
        let log_err = log.try_clone().map_err(|error| error.to_string())?;

        let rc_port = free_port()?;
        let rc_url = format!("http://127.0.0.1:{rc_port}/");
        let rc_user = "explorie".to_string();
        let rc_pass = Uuid::new_v4().simple().to_string();
        let remote = remote_spec(profile);
        let mut command = Command::new(&rclone);

        #[cfg(windows)]
        command.args([
            "mount",
            &remote,
            &profile.mount_target,
            "--volname",
            &profile.name,
            "--vfs-cache-mode",
            "writes",
        ]);

        #[cfg(target_os = "macos")]
        let nfs_port = {
            let port = free_port()?;
            command.args([
                "serve",
                "nfs",
                &remote,
                "--addr",
                &format!("127.0.0.1:{port}"),
                "--vfs-cache-mode",
                "full",
            ]);
            port
        };

        #[cfg(not(any(windows, target_os = "macos")))]
        return Err("Remote Drives currently support Windows and macOS only.".to_string());

        command
            .args(["--cache-dir"])
            .arg(&cache_dir)
            .args(["--rc", "--rc-addr"])
            .arg(format!("127.0.0.1:{rc_port}"))
            .env("RCLONE_RC_USER", &rc_user)
            .env("RCLONE_RC_PASS", &rc_pass)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));

        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to start rclone: {error}"))?;
        if let Err(error) = wait_for_rc(&mut child, &rclone, &rc_url, &rc_user, &rc_pass) {
            let _ = child.kill();
            return Err(error);
        }

        #[cfg(target_os = "macos")]
        if let Err(error) = macos_mount(&profile.id, &profile.mount_target, nfs_port) {
            let _ = rc_call(&rclone, &rc_url, &rc_user, &rc_pass, "core/quit");
            let _ = child.kill();
            return Err(error);
        }

        let running = RunningMount {
            child,
            rclone,
            rc_url,
            rc_user,
            rc_pass,
            mount_path: mount_path.clone(),
        };
        self.mounts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(profile.id.clone(), running);
        Ok(connected_status(&profile.id, &mount_path))
    }

    pub fn disconnect(
        &self,
        app: &AppHandle,
        id: &str,
        force: bool,
    ) -> Result<DisconnectResult, String> {
        let mut mount = {
            let mut mounts = self
                .mounts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some(mount) = mounts.remove(id) else {
                return Ok(DisconnectResult {
                    status: status(id, "disconnected", None, None),
                    pending_uploads: 0,
                    errored_files: 0,
                    blocked: false,
                });
            };
            mount
        };

        let (pending, errors) = vfs_stats(&mount).unwrap_or((0, 0));
        if !force && (pending > 0 || errors > 0) {
            self.mounts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(id.to_string(), mount);
            return Ok(DisconnectResult {
                status: status(id, "connected", None, None),
                pending_uploads: pending,
                errored_files: errors,
                blocked: true,
            });
        }

        emit_status(
            app,
            status(
                id,
                "disconnecting",
                Some(mount.mount_path.to_string_lossy().into_owned()),
                None,
            ),
        );
        #[cfg(target_os = "macos")]
        if let Err(error) = macos_unmount(id, mount.mount_path.to_string_lossy().as_ref(), force) {
            self.mounts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(id.to_string(), mount);
            return Err(error);
        }

        let _ = rc_call(
            &mount.rclone,
            &mount.rc_url,
            &mount.rc_user,
            &mount.rc_pass,
            "core/quit",
        );
        wait_or_kill(&mut mount.child);
        let status = status(id, "disconnected", None, None);
        emit_status(app, status.clone());
        Ok(DisconnectResult {
            status,
            pending_uploads: pending,
            errored_files: errors,
            blocked: false,
        })
    }

    pub fn disconnect_all(&self, app: &AppHandle) {
        let ids: Vec<String> = self
            .mounts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        for id in ids {
            let _ = self.disconnect(app, &id, true);
        }
    }

    pub fn disconnect_all_if_clean(&self, app: &AppHandle) -> bool {
        let ids: Vec<String> = self
            .mounts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        let mut blocker = RemoteDriveExitBlocker {
            pending_uploads: 0,
            errored_files: 0,
            error: None,
        };
        for id in ids {
            match self.disconnect(app, &id, false) {
                Ok(result) if result.blocked => {
                    blocker.pending_uploads += result.pending_uploads;
                    blocker.errored_files += result.errored_files;
                }
                Ok(_) => {}
                Err(error) => blocker.error = Some(error),
            }
        }
        let clean =
            blocker.pending_uploads == 0 && blocker.errored_files == 0 && blocker.error.is_none();
        if !clean {
            let _ = app.emit("remote-drive-exit-blocked", blocker);
        }
        clean
    }
}

fn validate_profile(profile: &RemoteDriveProfile) -> Result<(), String> {
    if Uuid::parse_str(&profile.id).is_err() {
        return Err("Remote drive ID must be a UUID.".to_string());
    }
    if profile.name.trim().is_empty()
        || profile.name.len() > 64
        || profile.name.chars().any(char::is_control)
    {
        return Err("Remote drive name must be 1-64 printable characters.".to_string());
    }
    if profile.remote.trim().is_empty()
        || profile.remote.contains([':', '/', '\\'])
        || profile.remote.chars().any(char::is_control)
    {
        return Err("Select a configured rclone remote.".to_string());
    }
    if profile
        .remote_path
        .split('/')
        .any(|part| part == "." || part == ".." || part.contains('\\'))
        || profile.remote_path.starts_with('/')
        || profile.remote_path.chars().any(char::is_control)
    {
        return Err("Remote subpath must be a relative rclone path.".to_string());
    }

    #[cfg(windows)]
    if !is_windows_drive_target(&profile.mount_target) {
        return Err("Choose an unused Windows drive letter from D: through Z:.".to_string());
    }

    #[cfg(target_os = "macos")]
    validate_volume_name(&profile.mount_target)?;
    Ok(())
}

#[cfg(windows)]
fn is_windows_drive_target(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 2 && (b'D'..=b'Z').contains(&bytes[0].to_ascii_uppercase()) && bytes[1] == b':'
}

#[cfg(target_os = "macos")]
fn validate_volume_name(value: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > 64
        || matches!(value, "." | "..")
        || value.contains(['/', '\\'])
        || value.chars().any(char::is_control)
    {
        return Err("macOS volume names must be 1-64 printable path-safe characters.".to_string());
    }
    Ok(())
}

fn remote_spec(profile: &RemoteDriveProfile) -> String {
    let path = profile.remote_path.trim_matches('/');
    if path.is_empty() {
        format!("{}:", profile.remote)
    } else {
        format!("{}:{path}", profile.remote)
    }
}

fn mount_path(profile: &RemoteDriveProfile) -> Result<PathBuf, String> {
    #[cfg(windows)]
    return Ok(PathBuf::from(format!(
        "{}\\",
        profile.mount_target.to_ascii_uppercase()
    )));
    #[cfg(target_os = "macos")]
    return Ok(Path::new("/Volumes").join(&profile.mount_target));
    #[cfg(not(any(windows, target_os = "macos")))]
    Err("Remote Drives currently support Windows and macOS only.".to_string())
}

fn ensure_mount_target_available(path: &Path) -> Result<(), String> {
    if path.try_exists().map_err(|error| error.to_string())? {
        return Err(format!(
            "Mount target is already in use: {}",
            path.display()
        ));
    }
    Ok(())
}

fn profile_cache_dir(app_cache_dir: &Path, profile_id: &str) -> PathBuf {
    app_cache_dir.join("remote-drives").join(profile_id)
}

#[cfg(windows)]
fn occupied_mount_targets() -> Vec<String> {
    (b'D'..=b'Z')
        .filter_map(|letter| {
            let target = format!("{}:", char::from(letter));
            Path::new(&format!("{target}\\"))
                .try_exists()
                .unwrap_or(true)
                .then_some(target)
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn occupied_mount_targets() -> Vec<String> {
    fs::read_dir("/Volumes")
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn occupied_mount_targets() -> Vec<String> {
    Vec::new()
}

fn parse_remotes(output: &str) -> Result<Vec<String>, String> {
    let mut remotes = Vec::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Some(name) = line.strip_suffix(':') else {
            return Err("rclone returned an invalid remote name.".to_string());
        };
        if name.is_empty() || name.contains([':', '/', '\\']) {
            return Err("rclone returned an invalid remote name.".to_string());
        }
        remotes.push(name.to_string());
    }
    remotes.sort();
    remotes.dedup();
    Ok(remotes)
}

fn find_rclone(app: &AppHandle) -> Option<PathBuf> {
    let binary_name = if cfg!(windows) {
        "rclone.exe"
    } else {
        "rclone"
    };
    let mut candidates = Vec::new();
    if let Ok(current_exe) = std::env::current_exe()
        && let Some(directory) = current_exe.parent()
    {
        candidates.push(directory.join(binary_name));
        if let Some(sidecar_name) = development_sidecar_name() {
            candidates.push(directory.join(sidecar_name));
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join(binary_name));
        candidates.push(resources.join("binaries").join(binary_name));
    }
    if let Some(sidecar_name) = development_sidecar_name() {
        candidates.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(sidecar_name),
        );
    }
    candidates.push(PathBuf::from("rclone"));
    #[cfg(windows)]
    {
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates.push(
                PathBuf::from(program_files)
                    .join("rclone")
                    .join("rclone.exe"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/rclone"),
        PathBuf::from("/usr/local/bin/rclone"),
        PathBuf::from("/usr/bin/rclone"),
    ]);
    candidates
        .into_iter()
        .find(|candidate| rclone_version(candidate).is_ok())
}

fn development_sidecar_name() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some("rclone-x86_64-pc-windows-msvc.exe")
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        Some("rclone-aarch64-pc-windows-msvc.exe")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("rclone-x86_64-apple-darwin")
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("rclone-aarch64-apple-darwin")
    } else {
        None
    }
}

fn rclone_version(rclone: &Path) -> Result<String, String> {
    let output = Command::new(rclone)
        .arg("version")
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("rclone version check failed".to_string());
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::to_string)
        .ok_or_else(|| "rclone version check returned no output".to_string())
}

fn ensure_rclone_capabilities(rclone: &Path) -> Result<(), String> {
    let args: &[&str] = if cfg!(target_os = "macos") {
        &["serve", "nfs", "--help"]
    } else {
        &["mount", "--help"]
    };
    let status = Command::new(rclone)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| error.to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "rclone 1.65 or newer with mount support is required.".to_string())
}

#[cfg(windows)]
fn winfsp_available() -> Option<bool> {
    Some(
        Command::new("sc.exe")
            .args(["query", "WinFsp.Launcher"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success()),
    )
}

pub fn install_winfsp(app: &AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        if winfsp_available() == Some(true) {
            return Ok(());
        }
        let mut candidates = Vec::new();
        if let Ok(resources) = app.path().resource_dir() {
            candidates.push(resources.join("installers").join("winfsp-2.1.25156.msi"));
        }
        candidates.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("winfsp-2.1.25156.msi"),
        );
        let bundled_installer = candidates
            .into_iter()
            .find(|path| path.is_file())
            .ok_or_else(|| {
                "The bundled WinFsp installer is unavailable. Reinstall Explorie.".to_string()
            })?;
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?
            .join("installers");
        fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
        let installer = cache_dir.join("winfsp-2.1.25156.msi");
        stage_winfsp_installer(&bundled_installer, &installer)?;
        let installer = normal_windows_path(&installer);
        let log = normal_windows_path(&cache_dir.join("winfsp-install.log"));
        let status = Command::new("msiexec.exe")
            .arg("/i")
            .arg(&installer)
            .arg("/norestart")
            .arg("/L*V")
            .arg(&log)
            .status()
            .map_err(|error| format!("Failed to open the WinFsp installer: {error}"))?;
        if !status.success() {
            return Err(format!(
                "WinFsp installation was cancelled or failed (exit code {}). Details: {}",
                status.code().unwrap_or(-1),
                log.display()
            ));
        }
        if winfsp_available() != Some(true) {
            return Err("WinFsp was installed but its launcher service is unavailable. Restart Windows and try again.".to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("WinFsp is only used on Windows.".to_string())
    }
}

#[cfg(windows)]
fn stage_winfsp_installer(source: &Path, destination: &Path) -> Result<(), String> {
    const EXPECTED_SHA256: &str =
        "073a70e00f77423e34bed98b86e600def93393ba5822204fac57a29324db9f7a";
    if file_sha256(source)? != EXPECTED_SHA256 {
        return Err(
            "The bundled WinFsp installer failed its integrity check. Reinstall Explorie."
                .to_string(),
        );
    }
    if destination.is_file() && file_sha256(destination)? == EXPECTED_SHA256 {
        return Ok(());
    }
    let staged = destination.with_extension("msi.tmp");
    fs::copy(source, &staged).map_err(|error| error.to_string())?;
    if file_sha256(&staged)? != EXPECTED_SHA256 {
        let _ = fs::remove_file(&staged);
        return Err("The staged WinFsp installer failed its integrity check.".to_string());
    }
    let _ = fs::remove_file(destination);
    fs::rename(staged, destination).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn file_sha256(path: &Path) -> Result<String, String> {
    use std::io::Read;

    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(windows)]
fn normal_windows_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{path}"))
    } else if let Some(path) = value.strip_prefix(r"\\?\") {
        PathBuf::from(path)
    } else {
        path.to_path_buf()
    }
}

#[cfg(not(windows))]
fn winfsp_available() -> Option<bool> {
    None
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| error.to_string())
}

fn wait_for_rc(
    child: &mut Child,
    rclone: &Path,
    url: &str,
    user: &str,
    pass: &str,
) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < READY_TIMEOUT {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!(
                "rclone exited before the mount was ready: {status}"
            ));
        }
        if rc_call(rclone, url, user, pass, "rc/noopauth").is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err("Timed out waiting for rclone to start.".to_string())
}

fn rc_call(
    rclone: &Path,
    url: &str,
    user: &str,
    pass: &str,
    endpoint: &str,
) -> Result<Value, String> {
    let output = Command::new(rclone)
        .args(["rc", "--url", url, endpoint])
        .env("RCLONE_RC_USER", user)
        .env("RCLONE_RC_PASS", pass)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(command_error(
            "rclone remote-control call failed",
            &output.stderr,
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

fn vfs_stats(mount: &RunningMount) -> Result<(u64, u64), String> {
    let stats = rc_call(
        &mount.rclone,
        &mount.rc_url,
        &mount.rc_user,
        &mount.rc_pass,
        "vfs/stats",
    )?;
    let cache = &stats["diskCache"];
    let pending = cache["uploadsQueued"].as_u64().unwrap_or(0)
        + cache["uploadsInProgress"].as_u64().unwrap_or(0);
    Ok((pending, cache["erroredFiles"].as_u64().unwrap_or(0)))
}

fn wait_or_kill(child: &mut Child) {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn emit_status(app: &AppHandle, status: RemoteDriveStatus) {
    let _ = app.emit("remote-drive-status", status);
}

fn status(
    id: &str,
    state: &'static str,
    mount_path: Option<String>,
    error: Option<String>,
) -> RemoteDriveStatus {
    RemoteDriveStatus {
        id: id.to_string(),
        state,
        mount_path,
        error,
    }
}

fn connected_status(id: &str, mount_path: &Path) -> RemoteDriveStatus {
    status(
        id,
        "connected",
        Some(mount_path.to_string_lossy().into_owned()),
        None,
    )
}

fn normalize_compare_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.trim_end_matches('/').to_ascii_lowercase()
    } else {
        value.trim_end_matches('/').to_string()
    }
}

fn command_error(prefix: &str, stderr: &[u8]) -> String {
    let detail = String::from_utf8_lossy(stderr).trim().to_string();
    if detail.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}: {detail}")
    }
}

fn missing_rclone() -> String {
    "The bundled rclone executable is unavailable. Reinstall Explorie or run prepare:rclone in development."
        .to_string()
}

#[cfg(target_os = "macos")]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{CStr, CString, c_char};

    unsafe extern "C" {
        fn explorie_mount_helper_status() -> i32;
        fn explorie_mount_helper_register() -> i32;
        fn explorie_mount_helper_unregister() -> i32;
        fn explorie_mount_helper_open_settings();
        fn explorie_mount_helper_mount(
            profile_id: *const c_char,
            volume_name: *const c_char,
            port: u16,
        ) -> *mut c_char;
        fn explorie_mount_helper_unmount(
            profile_id: *const c_char,
            volume_name: *const c_char,
            force: bool,
        ) -> *mut c_char;
        fn explorie_mount_helper_free(value: *mut c_char);
    }

    pub fn status() -> String {
        match unsafe { explorie_mount_helper_status() } {
            0 => "not-registered",
            1 => "enabled",
            2 => "approval-required",
            _ => "unavailable",
        }
        .to_string()
    }

    pub fn register() -> Result<String, String> {
        match unsafe { explorie_mount_helper_register() } {
            1 => Ok("enabled".to_string()),
            2 => Ok("approval-required".to_string()),
            _ => Err("Unable to register the Remote Drives helper.".to_string()),
        }
    }

    pub fn unregister() -> Result<(), String> {
        (unsafe { explorie_mount_helper_unregister() } == 0)
            .then_some(())
            .ok_or_else(|| "Unable to remove the Remote Drives helper.".to_string())
    }

    pub fn open_settings() {
        unsafe { explorie_mount_helper_open_settings() };
    }

    pub fn mount(id: &str, name: &str, port: u16) -> Result<(), String> {
        call(id, name, |id, name| unsafe {
            explorie_mount_helper_mount(id, name, port)
        })
    }

    pub fn unmount(id: &str, name: &str, force: bool) -> Result<(), String> {
        call(id, name, |id, name| unsafe {
            explorie_mount_helper_unmount(id, name, force)
        })
    }

    fn call(
        id: &str,
        name: &str,
        function: impl FnOnce(*const c_char, *const c_char) -> *mut c_char,
    ) -> Result<(), String> {
        let id = CString::new(id).map_err(|_| "Invalid helper request".to_string())?;
        let name = CString::new(name).map_err(|_| "Invalid helper request".to_string())?;
        let error = function(id.as_ptr(), name.as_ptr());
        if error.is_null() {
            return Ok(());
        }
        let message = unsafe { CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned();
        unsafe { explorie_mount_helper_free(error) };
        Err(message)
    }
}

#[cfg(target_os = "macos")]
fn macos_helper_status() -> Option<String> {
    Some(macos::status())
}

#[cfg(not(target_os = "macos"))]
fn macos_helper_status() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn macos_mount(id: &str, volume_name: &str, port: u16) -> Result<(), String> {
    if macos::status() != "enabled" {
        return Err("Approve the Explorie Remote Drives helper in System Settings.".to_string());
    }
    macos::mount(id, volume_name, port)
}

#[cfg(target_os = "macos")]
fn macos_unmount(id: &str, mount_path: &str, force: bool) -> Result<(), String> {
    let name = Path::new(mount_path)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid macOS mount path".to_string())?;
    macos::unmount(id, name, force)
}

pub fn register_macos_helper() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    return macos::register();
    #[cfg(not(target_os = "macos"))]
    Err("The privileged mount helper is only used on macOS.".to_string())
}

pub fn unregister_macos_helper() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::unregister();
    #[cfg(not(target_os = "macos"))]
    Err("The privileged mount helper is only used on macOS.".to_string())
}

pub fn open_macos_helper_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::open_settings();
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    Err("Helper settings are only available on macOS.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_sorts_remote_names() {
        assert_eq!(
            parse_remotes("zeta:\nalpha:\nalpha:\n").unwrap(),
            vec!["alpha", "zeta"]
        );
        assert!(parse_remotes("not-a-remote\n").is_err());
    }

    #[test]
    fn remote_spec_never_treats_subpath_as_a_local_path() {
        let profile = RemoteDriveProfile {
            id: Uuid::new_v4().to_string(),
            name: "Drive".to_string(),
            remote: "cloud".to_string(),
            remote_path: "folder/subfolder".to_string(),
            mount_target: "R:".to_string(),
        };
        assert_eq!(remote_spec(&profile), "cloud:folder/subfolder");
    }

    #[test]
    fn rejects_path_traversal_and_unconfigured_remote_shapes() {
        let mut profile = RemoteDriveProfile {
            id: Uuid::new_v4().to_string(),
            name: "Drive".to_string(),
            remote: "cloud".to_string(),
            remote_path: "../secret".to_string(),
            mount_target: "R:".to_string(),
        };
        assert!(validate_profile(&profile).is_err());
        profile.remote_path.clear();
        profile.remote = "cloud:path".to_string();
        assert!(validate_profile(&profile).is_err());
        profile.remote = "cloud".to_string();
        profile.remote_path = "/absolute".to_string();
        assert!(validate_profile(&profile).is_err());
    }

    #[test]
    fn cache_paths_are_stable_per_profile() {
        let base = Path::new("cache-root");
        assert_eq!(
            profile_cache_dir(base, "672ce77a-b72d-4e16-a9e8-55e0ac5bc580"),
            base.join("remote-drives")
                .join("672ce77a-b72d-4e16-a9e8-55e0ac5bc580")
        );
    }

    #[test]
    fn existing_mount_targets_are_rejected() {
        let target = std::env::temp_dir().join(format!("explorie-mount-test-{}", Uuid::new_v4()));
        fs::create_dir(&target).unwrap();
        assert!(ensure_mount_target_available(&target).is_err());
        fs::remove_dir(&target).unwrap();
        assert!(ensure_mount_target_available(&target).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_drop_verbatim_prefixes() {
        assert_eq!(
            normal_windows_path(Path::new(r"\\?\C:\Program Files\Explorie\winfsp.msi")),
            PathBuf::from(r"C:\Program Files\Explorie\winfsp.msi")
        );
        assert_eq!(
            normal_windows_path(Path::new(r"\\?\UNC\server\share\winfsp.msi")),
            PathBuf::from(r"\\server\share\winfsp.msi")
        );
    }
}
