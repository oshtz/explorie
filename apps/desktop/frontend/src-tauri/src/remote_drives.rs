use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

#[cfg(windows)]
use sha2::{Digest, Sha256};

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const RC_TIMEOUT: Duration = Duration::from_secs(5);
const PROCESS_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
const MOUNT_RETRY_MAX_ATTEMPTS: usize = 3;
const MOUNT_RETRY_INITIAL_BACKOFF: Duration = Duration::from_millis(250);
const MOUNT_RETRY_MAX_BACKOFF: Duration = Duration::from_secs(2);

const NO_REMOTES_CONFIGURED: &str =
    "No rclone remotes are configured. Choose Configure to add one, then try again.";
const REMOTE_NOT_CONFIGURED: &str = "The selected rclone remote is no longer configured. Choose Configure to refresh the remote list, then try again.";
const ENCRYPTED_CONFIG_UNLOCK: &str = "rclone's encrypted configuration could not be unlocked non-interactively. Set up the existing rclone password command or RCLONE_CONFIG_PASS, then try again.";
const WINFSP_REQUIRED: &str =
    "Install WinFsp before mounting remote drives on Windows, then try again.";
const MACOS_HELPER_APPROVAL: &str =
    "Approve the Explorie Remote Drives helper in macOS System Settings, then try again.";
const CONNECTION_CANCELLED: &str =
    "Remote drive connection was cancelled while Explorie was exiting.";
const CONNECTION_IN_PROGRESS: &str =
    "A remote drive connection is already in progress. Wait for it to finish, then try again.";
const CONNECTION_SHUTDOWN_TIMEOUT: &str =
    "A remote drive connection is still stopping. Wait a moment, then try again.";

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
    pub message: String,
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
    #[cfg(target_os = "macos")]
    profile_id: String,
    child: Child,
    rclone: PathBuf,
    rc_url: String,
    rc_user: String,
    rc_pass: String,
    mount_path: PathBuf,
}

enum MountAttemptError {
    Retryable(String),
    Terminal(String),
}

#[derive(Default)]
struct ConnectState {
    pending: HashMap<String, Arc<AtomicBool>>,
    shutdown_requested: bool,
}

#[derive(Clone, Default)]
pub struct RemoteDriveManager {
    mounts: Arc<Mutex<HashMap<String, RunningMount>>>,
    connects: Arc<Mutex<ConnectState>>,
}

impl RemoteDriveManager {
    fn begin_connect(&self, id: &str) -> Result<Arc<AtomicBool>, String> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut connects = self
            .connects
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if connects.shutdown_requested {
            return Err(CONNECTION_SHUTDOWN_TIMEOUT.to_string());
        }
        if connects.pending.contains_key(id) {
            return Err(CONNECTION_IN_PROGRESS.to_string());
        }
        connects.pending.insert(id.to_string(), cancelled.clone());
        Ok(cancelled)
    }

    fn finish_connect(&self, id: &str) {
        self.connects
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pending
            .remove(id);
    }

    fn cancel_pending_connects(&self, shutdown_requested: bool) {
        let mut connects = self
            .connects
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if shutdown_requested {
            connects.shutdown_requested = true;
        }
        for cancelled in connects.pending.values() {
            cancelled.store(true, Ordering::Release);
        }
    }

    fn wait_for_pending_connects(&self) -> bool {
        let started = Instant::now();
        while started.elapsed() < CONNECT_SHUTDOWN_TIMEOUT {
            if self
                .connects
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pending
                .is_empty()
            {
                return true;
            }
            thread::sleep(Duration::from_millis(25));
        }
        false
    }

    pub fn clear_shutdown_request(&self) {
        self.connects
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .shutdown_requested = false;
    }

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
        self.list_remotes_with_cancel(app, None)
    }

    fn list_remotes_with_cancel(
        &self,
        app: &AppHandle,
        cancelled: Option<&AtomicBool>,
    ) -> Result<Vec<String>, String> {
        let rclone = match find_rclone_with_cancel(app, cancelled) {
            Some(path) => path,
            None => {
                if let Some(cancelled) = cancelled {
                    check_cancelled(cancelled)?;
                }
                return Err(missing_rclone());
            }
        };
        let mut command = Command::new(rclone);
        command.args(["listremotes", "--ask-password=false"]);
        let output = command_output_with_timeout(&mut command, PROCESS_TIMEOUT, cancelled)
            .map_err(|error| actionable_rclone_error(&error))?;
        if !output.status.success() {
            return Err(actionable_rclone_error(&command_error(
                "rclone could not read its configuration",
                &output.stderr,
            )));
        }
        parse_remotes(&String::from_utf8_lossy(&output.stdout))
            .map_err(|error| actionable_rclone_error(&error))
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
                Ok(Some(exit_status)) => status(
                    id,
                    "error",
                    Some(mount.mount_path.to_string_lossy().into_owned()),
                    Some(format!("rclone exited with {exit_status}")),
                ),
                Ok(None) => connected_status(id, &mount.mount_path),
                Err(error) => status(
                    id,
                    "error",
                    Some(mount.mount_path.to_string_lossy().into_owned()),
                    Some(error.to_string()),
                ),
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

        let cancelled = self.begin_connect(&profile.id)?;
        emit_status(app, status(&profile.id, "connecting", None, None));
        let result = self.connect_inner(app, &profile, &cancelled);
        let outcome = match result {
            Ok(status) => {
                emit_status(app, status.clone());
                Ok(status)
            }
            Err(error) => {
                let message = actionable_remote_error(&error);
                emit_status(
                    app,
                    status(&profile.id, "error", None, Some(message.clone())),
                );
                Err(message)
            }
        };
        self.finish_connect(&profile.id);
        outcome
    }

    fn connect_inner(
        &self,
        app: &AppHandle,
        profile: &RemoteDriveProfile,
        cancelled: &AtomicBool,
    ) -> Result<RemoteDriveStatus, String> {
        check_cancelled(cancelled)?;
        let rclone = match find_rclone_with_cancel(app, Some(cancelled)) {
            Some(path) => path,
            None => {
                check_cancelled(cancelled)?;
                return Err(missing_rclone());
            }
        };
        ensure_rclone_capabilities_with_cancel(&rclone, Some(cancelled))?;
        let remotes = self.list_remotes_with_cancel(app, Some(cancelled))?;
        if remotes.is_empty() {
            return Err(NO_REMOTES_CONFIGURED.to_string());
        }
        if !remotes.iter().any(|remote| remote == &profile.remote) {
            return Err(REMOTE_NOT_CONFIGURED.to_string());
        }
        #[cfg(windows)]
        if winfsp_available() != Some(true) {
            return Err(WINFSP_REQUIRED.to_string());
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
        let running = retry_mount(
            |attempt| {
                if cancelled.load(Ordering::Acquire) {
                    return Err(MountAttemptError::Terminal(
                        CONNECTION_CANCELLED.to_string(),
                    ));
                }
                if attempt > 1 {
                    emit_status(
                        app,
                        status_with_message(
                            &profile.id,
                            "connecting",
                            None,
                            format!(
                                "Retrying the remote mount ({attempt}/{MOUNT_RETRY_MAX_ATTEMPTS}) after a transient failure. If it still fails, select the drive to try again."
                            ),
                        ),
                    );
                }
                mount_once(&rclone, profile, &cache_dir, &mount_path, cancelled)
            },
            thread::sleep,
        )?;
        if cancelled.load(Ordering::Acquire) {
            terminate_mount(running);
            return Err(CONNECTION_CANCELLED.to_string());
        }
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

        let (pending, errors) = match disconnect_stats(force, || vfs_stats(&mount)) {
            Ok(stats) => stats,
            Err(error) => {
                let mount_path = mount.mount_path.to_string_lossy().into_owned();
                self.mounts
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(id.to_string(), mount);
                return Ok(DisconnectResult {
                    status: status(
                        id,
                        "connected",
                        Some(mount_path),
                        Some(format!("Unable to verify pending remote writes: {error}")),
                    ),
                    pending_uploads: 0,
                    errored_files: 0,
                    blocked: true,
                });
            }
        };
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

    pub fn disconnect_all(&self, app: &AppHandle) -> bool {
        self.cancel_pending_connects(true);
        let pending_stopped = self.wait_for_pending_connects();
        let ids: Vec<String> = self
            .mounts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        let mut clean = pending_stopped;
        for id in ids {
            if self.disconnect(app, &id, true).is_err() {
                clean = false;
            }
        }
        if !clean {
            self.clear_shutdown_request();
        }
        clean
    }

    pub fn disconnect_all_if_clean(&self, app: &AppHandle) -> bool {
        self.cancel_pending_connects(true);
        let pending_stopped = self.wait_for_pending_connects();
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
        if !pending_stopped {
            blocker.error = Some(CONNECTION_SHUTDOWN_TIMEOUT.to_string());
        }
        for id in ids {
            match self.disconnect(app, &id, false) {
                Ok(result) if result.blocked => {
                    blocker.pending_uploads += result.pending_uploads;
                    blocker.errored_files += result.errored_files;
                    if result.status.error.is_some() {
                        blocker.error = result.status.error;
                    }
                }
                Ok(_) => {}
                Err(error) => blocker.error = Some(error),
            }
        }
        let clean = pending_stopped
            && blocker.pending_uploads == 0
            && blocker.errored_files == 0
            && blocker.error.is_none();
        if !clean {
            self.clear_shutdown_request();
            let _ = app.emit("remote-drive-exit-blocked", blocker);
        }
        clean
    }
}

fn mount_once(
    rclone: &Path,
    profile: &RemoteDriveProfile,
    cache_dir: &Path,
    mount_path: &Path,
    cancelled: &AtomicBool,
) -> Result<RunningMount, MountAttemptError> {
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (rclone, profile, cache_dir, mount_path, cancelled);
        return Err(MountAttemptError::Terminal(
            "Remote Drives currently support Windows and macOS only.".to_string(),
        ));
    }

    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(cache_dir.join("rclone.log"))
        .map_err(|error| MountAttemptError::Terminal(error.to_string()))?;
    let log_err = log
        .try_clone()
        .map_err(|error| MountAttemptError::Terminal(error.to_string()))?;

    let rc_port = free_port().map_err(MountAttemptError::Terminal)?;
    let rc_url = format!("http://127.0.0.1:{rc_port}/");
    let rc_user = "explorie".to_string();
    let rc_pass = Uuid::new_v4().simple().to_string();
    let remote = remote_spec(profile);
    let mut command = Command::new(rclone);

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
        let port = free_port().map_err(MountAttemptError::Terminal)?;
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

    command
        .args(["--cache-dir"])
        .arg(cache_dir)
        .args(["--rc", "--rc-addr"])
        .arg(format!("127.0.0.1:{rc_port}"))
        .env("RCLONE_RC_USER", &rc_user)
        .env("RCLONE_RC_PASS", &rc_pass)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));

    let mut child = command
        .spawn()
        .map_err(|error| MountAttemptError::Terminal(format!("Failed to start rclone: {error}")))?;
    if let Err(error) = wait_for_rc(&mut child, rclone, &rc_url, &rc_user, &rc_pass, cancelled) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(if cancelled.load(Ordering::Acquire) {
            MountAttemptError::Terminal(CONNECTION_CANCELLED.to_string())
        } else {
            MountAttemptError::Retryable(error)
        });
    }

    #[cfg(target_os = "macos")]
    if let Err(error) = macos_mount(&profile.id, &profile.mount_target, nfs_port) {
        let _ = rc_call(rclone, &rc_url, &rc_user, &rc_pass, "core/quit");
        let _ = child.kill();
        let _ = child.wait();
        return Err(MountAttemptError::Terminal(error));
    }

    let running = RunningMount {
        #[cfg(target_os = "macos")]
        profile_id: profile.id.clone(),
        child,
        rclone: rclone.to_path_buf(),
        rc_url,
        rc_user,
        rc_pass,
        mount_path: mount_path.to_path_buf(),
    };
    if cancelled.load(Ordering::Acquire) {
        terminate_mount(running);
        return Err(MountAttemptError::Terminal(
            CONNECTION_CANCELLED.to_string(),
        ));
    }
    Ok(running)
}

fn retry_mount<T, Attempt, Sleep>(mut attempt: Attempt, mut sleep: Sleep) -> Result<T, String>
where
    Attempt: FnMut(usize) -> Result<T, MountAttemptError>,
    Sleep: FnMut(Duration),
{
    let mut backoff = MOUNT_RETRY_INITIAL_BACKOFF;
    for number in 1..=MOUNT_RETRY_MAX_ATTEMPTS {
        match attempt(number) {
            Ok(value) => return Ok(value),
            Err(MountAttemptError::Terminal(error)) => return Err(error),
            Err(MountAttemptError::Retryable(_error)) if number < MOUNT_RETRY_MAX_ATTEMPTS => {
                sleep(backoff);
                backoff = std::cmp::min(backoff + backoff, MOUNT_RETRY_MAX_BACKOFF);
            }
            Err(MountAttemptError::Retryable(error)) => {
                return Err(format!("The mount failed after {number} attempts: {error}"));
            }
        }
    }
    unreachable!("mount retry loop always returns from an attempt")
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
    find_rclone_with_cancel(app, None)
}

fn find_rclone_with_cancel(app: &AppHandle, cancelled: Option<&AtomicBool>) -> Option<PathBuf> {
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
    for candidate in candidates {
        if cancelled.is_some_and(|value| value.load(Ordering::Acquire)) {
            return None;
        }
        if rclone_version_with_cancel(&candidate, cancelled).is_ok() {
            return Some(candidate);
        }
    }
    None
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
    rclone_version_with_cancel(rclone, None)
}

fn rclone_version_with_cancel(
    rclone: &Path,
    cancelled: Option<&AtomicBool>,
) -> Result<String, String> {
    let mut command = Command::new(rclone);
    command.arg("version");
    let output = command_output_with_timeout(&mut command, PROCESS_TIMEOUT, cancelled)?;
    if !output.status.success() {
        return Err("rclone version check failed".to_string());
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::to_string)
        .ok_or_else(|| "rclone version check returned no output".to_string())
}

fn ensure_rclone_capabilities_with_cancel(
    rclone: &Path,
    cancelled: Option<&AtomicBool>,
) -> Result<(), String> {
    let args: &[&str] = if cfg!(target_os = "macos") {
        &["serve", "nfs", "--help"]
    } else {
        &["mount", "--help"]
    };
    let mut command = Command::new(rclone);
    command
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let status = command_status_with_timeout(&mut command, PROCESS_TIMEOUT, cancelled)?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "rclone 1.65 or newer with mount support is required.".to_string())
}

fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    cancelled: Option<&AtomicBool>,
) -> Result<std::process::Output, String> {
    let token = Uuid::new_v4().simple().to_string();
    let stdout_path = std::env::temp_dir().join(format!("explorie-rclone-{token}.stdout"));
    let stderr_path = std::env::temp_dir().join(format!("explorie-rclone-{token}.stderr"));
    let result = (|| {
        let stdout = File::create(&stdout_path).map_err(|error| error.to_string())?;
        let stderr = File::create(&stderr_path).map_err(|error| error.to_string())?;
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .spawn()
            .map_err(|error| error.to_string())?;
        let status = wait_for_process(&mut child, timeout, cancelled)?;
        let stdout = fs::read(&stdout_path).map_err(|error| error.to_string())?;
        let stderr = fs::read(&stderr_path).map_err(|error| error.to_string())?;
        Ok(std::process::Output {
            status,
            stdout,
            stderr,
        })
    })();
    let _ = fs::remove_file(stdout_path);
    let _ = fs::remove_file(stderr_path);
    result
}

fn command_status_with_timeout(
    command: &mut Command,
    timeout: Duration,
    cancelled: Option<&AtomicBool>,
) -> Result<std::process::ExitStatus, String> {
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    wait_for_process(&mut child, timeout, cancelled)
}

fn wait_for_process(
    child: &mut Child,
    timeout: Duration,
    cancelled: Option<&AtomicBool>,
) -> Result<std::process::ExitStatus, String> {
    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return child.wait().map_err(|error| error.to_string());
        }
        if cancelled.is_some_and(|value| value.load(Ordering::Acquire)) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CONNECTION_CANCELLED.to_string());
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "rclone command timed out after {timeout:?}. Try again after the remote configuration settles."
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
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
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < READY_TIMEOUT {
        check_cancelled(cancelled)?;
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!(
                "rclone exited before the mount was ready: {status}"
            ));
        }
        if rc_call_with_cancel(rclone, url, user, pass, "rc/noopauth", Some(cancelled)).is_ok() {
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
    rc_call_with_cancel(rclone, url, user, pass, endpoint, None)
}

fn rc_call_with_cancel(
    rclone: &Path,
    url: &str,
    user: &str,
    pass: &str,
    endpoint: &str,
    cancelled: Option<&AtomicBool>,
) -> Result<Value, String> {
    let mut child = Command::new(rclone)
        .args(["rc", "--url", url, endpoint])
        .env("RCLONE_RC_USER", user)
        .env("RCLONE_RC_PASS", pass)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let started = Instant::now();
    while child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        if cancelled.is_some_and(|value| value.load(Ordering::Acquire)) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CONNECTION_CANCELLED.to_string());
        }
        if started.elapsed() >= RC_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "rclone remote-control call timed out after {RC_TIMEOUT:?}"
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(command_error(
            "rclone remote-control call failed",
            &output.stderr,
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

fn disconnect_stats(
    force: bool,
    get_stats: impl FnOnce() -> Result<(u64, u64), String>,
) -> Result<(u64, u64), String> {
    if force { Ok((0, 0)) } else { get_stats() }
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

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        Err(CONNECTION_CANCELLED.to_string())
    } else {
        Ok(())
    }
}

fn terminate_mount(mut mount: RunningMount) {
    #[cfg(target_os = "macos")]
    let _ = macos_unmount(&mount.profile_id, &mount.mount_path.to_string_lossy(), true);
    let _ = rc_call(
        &mount.rclone,
        &mount.rc_url,
        &mount.rc_user,
        &mount.rc_pass,
        "core/quit",
    );
    wait_or_kill(&mut mount.child);
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
    let error = error.map(|detail| actionable_status_error(state, &detail));
    let message = status_message(state, error.as_deref());
    RemoteDriveStatus {
        id: id.to_string(),
        state,
        mount_path,
        message,
        error,
    }
}

fn status_with_message(
    id: &str,
    state: &'static str,
    mount_path: Option<String>,
    message: String,
) -> RemoteDriveStatus {
    RemoteDriveStatus {
        id: id.to_string(),
        state,
        mount_path,
        message,
        error: None,
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

fn status_message(state: &str, error: Option<&str>) -> String {
    match state {
        "connecting" => error.map(str::to_string).unwrap_or_else(|| {
            "Connecting to the remote. Transient mount failures will be retried; select the drive again if it still fails.".to_string()
        }),
        "connected" => error.map(str::to_string).unwrap_or_else(|| {
            "Connected. Select the drive to browse its files, or use Disconnect to stop the mount."
                .to_string()
        }),
        "disconnected" => {
            "Disconnected. Select the drive to try the mount again.".to_string()
        }
        "disconnecting" => error.map(str::to_string).unwrap_or_else(|| {
            "Disconnecting and checking pending remote writes. Please wait.".to_string()
        }),
        "approval-required" => MACOS_HELPER_APPROVAL.to_string(),
        "error" => error.map(str::to_string).unwrap_or_else(|| {
            "Remote drive mount failed. Check the remote configuration and network connection, then try again."
                .to_string()
        }),
        _ => error
            .map(str::to_string)
            .unwrap_or_else(|| "Remote drive status is unavailable. Try again.".to_string()),
    }
}

fn actionable_status_error(state: &str, detail: &str) -> String {
    if state == "error" {
        actionable_remote_error(detail)
    } else if detail.ends_with('.') {
        format!("{detail} Try again after the remote operation settles.")
    } else {
        format!("{detail}. Try again after the remote operation settles.")
    }
}

fn actionable_rclone_error(detail: &str) -> String {
    actionable_remote_error(detail)
}

fn actionable_remote_error(detail: &str) -> String {
    let detail = detail.trim();
    let lower = detail.to_ascii_lowercase();
    if lower.starts_with("remote drive mount failed:") {
        return detail.to_string();
    }
    if lower.contains("no remotes") || lower.contains("without creating a remote") {
        return NO_REMOTES_CONFIGURED.to_string();
    }
    if lower.contains("selected rclone remote is no longer configured") {
        return REMOTE_NOT_CONFIGURED.to_string();
    }
    if lower.contains("encrypted")
        || lower.contains("unable to decrypt")
        || lower.contains("failed to decrypt")
        || lower.contains("password required")
        || lower.contains("non-interactive")
        || lower.contains("noninteractive")
    {
        return ENCRYPTED_CONFIG_UNLOCK.to_string();
    }
    if lower.contains("winfsp") || lower.contains("windows filesystem driver") {
        return WINFSP_REQUIRED.to_string();
    }
    if (lower.contains("approve") && lower.contains("helper"))
        || lower.contains("approval-required")
        || (lower.contains("system settings") && lower.contains("mount"))
    {
        return MACOS_HELPER_APPROVAL.to_string();
    }
    if detail.is_empty() {
        return "Remote drive mount failed. Check the remote configuration and network connection, then try again."
            .to_string();
    }
    let punctuation = if detail.ends_with(['.', '!', '?']) {
        ""
    } else {
        "."
    };
    format!(
        "Remote drive mount failed: {detail}{punctuation} Check the remote configuration and network connection, then try again."
    )
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

    #[test]
    fn forced_disconnect_skips_unavailable_remote_stats() {
        assert_eq!(
            disconnect_stats(true, || Err("offline".to_string())),
            Ok((0, 0))
        );
        assert_eq!(
            disconnect_stats(false, || Err("offline".to_string())),
            Err("offline".to_string())
        );
    }

    #[test]
    fn retries_transient_mount_until_it_succeeds() {
        let mut attempts = 0;
        let mut delays = Vec::new();
        let result = retry_mount(
            |_| {
                attempts += 1;
                if attempts < 3 {
                    Err(MountAttemptError::Retryable(
                        "remote unavailable".to_string(),
                    ))
                } else {
                    Ok("mounted")
                }
            },
            |delay| delays.push(delay),
        );

        assert_eq!(result, Ok("mounted"));
        assert_eq!(attempts, 3);
        assert_eq!(
            delays,
            vec![
                MOUNT_RETRY_INITIAL_BACKOFF,
                MOUNT_RETRY_INITIAL_BACKOFF + MOUNT_RETRY_INITIAL_BACKOFF,
            ]
        );
    }

    #[test]
    fn gives_up_after_bounded_transient_mount_retries() {
        let mut attempts = 0;
        let mut delays = Vec::new();
        let result: Result<(), String> = retry_mount(
            |_| {
                attempts += 1;
                Err(MountAttemptError::Retryable(
                    "remote unavailable".to_string(),
                ))
            },
            |delay| delays.push(delay),
        );

        assert_eq!(
            result,
            Err("The mount failed after 3 attempts: remote unavailable".to_string())
        );
        assert_eq!(attempts, MOUNT_RETRY_MAX_ATTEMPTS);
        assert_eq!(
            delays,
            vec![
                MOUNT_RETRY_INITIAL_BACKOFF,
                MOUNT_RETRY_INITIAL_BACKOFF + MOUNT_RETRY_INITIAL_BACKOFF,
            ]
        );
    }

    #[test]
    fn shutdown_cancels_pending_connect_before_teardown_snapshot() {
        let manager = RemoteDriveManager::default();
        let cancelled = manager.begin_connect("drive").unwrap();
        let worker_manager = manager.clone();
        let worker_cancelled = cancelled.clone();
        let worker = thread::spawn(move || {
            while !worker_cancelled.load(Ordering::Acquire) {
                thread::yield_now();
            }
            worker_manager.finish_connect("drive");
        });

        manager.cancel_pending_connects(true);
        assert!(manager.wait_for_pending_connects());
        worker.join().unwrap();
        assert_eq!(
            manager.begin_connect("next-drive").unwrap_err(),
            CONNECTION_SHUTDOWN_TIMEOUT
        );
        manager.clear_shutdown_request();
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn rclone_process_checks_have_a_hard_timeout() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "exec sleep 30"]);
            command
        };
        let started = Instant::now();
        let error = command_output_with_timeout(&mut command, Duration::from_millis(100), None)
            .unwrap_err();
        assert!(
            error.contains("timed out"),
            "unexpected timeout error: {error}"
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn rclone_process_checks_honor_exit_cancellation() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "exec sleep 30"]);
            command
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        let setter = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            signal.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let error =
            command_output_with_timeout(&mut command, Duration::from_secs(5), Some(&cancelled))
                .unwrap_err();
        setter.join().unwrap();
        assert_eq!(error, CONNECTION_CANCELLED);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn status_messages_name_the_next_action_for_every_lifecycle_state() {
        for state in [
            "connecting",
            "connected",
            "disconnected",
            "disconnecting",
            "approval-required",
            "error",
        ] {
            let status = status("drive", state, None, None);
            assert!(!status.message.trim().is_empty(), "{state} has no message");
            let message = status.message.to_ascii_lowercase();
            assert!(
                message.contains("try")
                    || message.contains("select")
                    || message.contains("connected")
                    || message.contains("disconnecting"),
                "{state} message is not actionable: {}",
                status.message
            );
        }
    }

    #[test]
    fn common_rclone_failures_are_actionable_without_storing_secrets() {
        assert_eq!(
            actionable_rclone_error("no remotes found"),
            NO_REMOTES_CONFIGURED
        );
        assert_eq!(
            actionable_rclone_error("config is encrypted and password required"),
            ENCRYPTED_CONFIG_UNLOCK
        );
        assert_eq!(
            actionable_rclone_error("WinFsp is not installed"),
            WINFSP_REQUIRED
        );
        assert_eq!(
            actionable_rclone_error("Approve the mount helper in System Settings"),
            MACOS_HELPER_APPROVAL
        );
        let generic = actionable_rclone_error("rclone exited with exit status: 1");
        assert!(generic.contains("Check the remote configuration"));
        assert!(!generic.contains("RCLONE_CONFIG_PASS"));
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
