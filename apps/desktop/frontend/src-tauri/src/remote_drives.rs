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
use tauri::{AppHandle, Emitter, Manager, Runtime};
use uuid::Uuid;

#[cfg(test)]
use tauri::Listener;

#[cfg(windows)]
use sha2::{Digest, Sha256};

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const RC_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_ATTEMPTS: usize = 3;

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
    rclone_environment: RcloneProcessEnvironment,
}

#[derive(Clone, Default)]
struct RcloneProcessEnvironment {
    command_prefix: Vec<String>,
    control_file: Option<PathBuf>,
    state_file: Option<PathBuf>,
    attempt_file: Option<PathBuf>,
    fail_attempts: Option<u32>,
    alive_file: Option<PathBuf>,
    response_file: Option<PathBuf>,
}

#[cfg(test)]
struct TestRuntime {
    rclone: PathBuf,
    cache_dir: PathBuf,
    mount_path: PathBuf,
    rclone_environment: RcloneProcessEnvironment,
}

#[derive(Clone, Default)]
pub struct RemoteDriveManager {
    mounts: Arc<Mutex<HashMap<String, RunningMount>>>,
    #[cfg(test)]
    test_runtime: Option<Arc<TestRuntime>>,
}

impl RemoteDriveManager {
    pub fn environment<R: Runtime>(&self, app: &AppHandle<R>) -> RemoteDriveEnvironment {
        let rclone = self.rclone_for(app);
        let version = rclone
            .as_ref()
            .and_then(|(path, environment)| rclone_version(path, environment).ok());
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

    pub fn list_remotes<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Vec<String>, String> {
        let (rclone, environment) = self.rclone_for(app).ok_or_else(missing_rclone)?;
        let output = rclone_command(
            &rclone,
            &environment,
            [
                "listremotes".to_string(),
                "--ask-password=false".to_string(),
            ],
        )
        .output()
        .map_err(|error| format!("Failed to run rclone: {error}"))?;
        if !output.status.success() {
            return Err(command_error(
                "rclone could not read its configuration",
                &output.stderr,
            ));
        }
        let stdout = read_fake_response(&environment, &output.stdout)?;
        parse_remotes(&String::from_utf8_lossy(&stdout))
    }

    pub fn configure_remotes<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
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

    fn rclone_for<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Option<(PathBuf, RcloneProcessEnvironment)> {
        #[cfg(test)]
        if let Some(runtime) = &self.test_runtime {
            return Some((runtime.rclone.clone(), runtime.rclone_environment.clone()));
        }

        find_rclone(app).map(|path| (path, RcloneProcessEnvironment::default()))
    }

    fn using_test_runtime(&self) -> bool {
        #[cfg(test)]
        return self.test_runtime.is_some();
        #[cfg(not(test))]
        false
    }

    #[cfg(test)]
    fn with_test_runtime(
        rclone: PathBuf,
        cache_dir: PathBuf,
        mount_path: PathBuf,
        rclone_environment: RcloneProcessEnvironment,
    ) -> Self {
        Self {
            mounts: Arc::new(Mutex::new(HashMap::new())),
            test_runtime: Some(Arc::new(TestRuntime {
                rclone,
                cache_dir,
                mount_path,
                rclone_environment,
            })),
        }
    }

    #[cfg(test)]
    fn test_child_ids(&self) -> Vec<u32> {
        self.mounts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .map(|mount| mount.child.id())
            .collect()
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

    pub fn connect<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        profile: RemoteDriveProfile,
    ) -> Result<RemoteDriveStatus, String> {
        validate_profile(&profile)?;
        #[cfg(target_os = "macos")]
        if !self.using_test_runtime() && macos::status() != "enabled" {
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
        let mut last_error = None;
        for attempt in 0..CONNECT_ATTEMPTS {
            match self.connect_inner(app, &profile) {
                Ok(status) => {
                    emit_status(app, status.clone());
                    return Ok(status);
                }
                Err(error) => {
                    last_error = Some(error);
                    if attempt + 1 < CONNECT_ATTEMPTS {
                        thread::sleep(Duration::from_millis(250 * (1_u64 << attempt)));
                    }
                }
            }
        }

        let error = last_error.unwrap_or_else(|| "Remote drive connection failed.".to_string());
        emit_status(app, status(&profile.id, "error", None, Some(error.clone())));
        Err(error)
    }

    fn connect_inner<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        profile: &RemoteDriveProfile,
    ) -> Result<RemoteDriveStatus, String> {
        let (rclone, rclone_environment) = self.rclone_for(app).ok_or_else(missing_rclone)?;
        ensure_rclone_capabilities(&rclone, &rclone_environment)?;
        if !self
            .list_remotes(app)?
            .iter()
            .any(|remote| remote == &profile.remote)
        {
            return Err("The selected rclone remote is no longer configured.".to_string());
        }
        #[cfg(windows)]
        if !self.using_test_runtime() && winfsp_available() != Some(true) {
            return Err("Install WinFsp before mounting remote drives on Windows.".to_string());
        }

        #[cfg(test)]
        let mount_path = self
            .test_runtime
            .as_ref()
            .map(|runtime| runtime.mount_path.clone())
            .unwrap_or(mount_path(profile)?);
        #[cfg(not(test))]
        let mount_path = mount_path(profile)?;
        ensure_mount_target_available(&mount_path)?;
        #[cfg(test)]
        let cache_dir = self
            .test_runtime
            .as_ref()
            .map(|runtime| profile_cache_dir(&runtime.cache_dir, &profile.id))
            .unwrap_or(profile_cache_dir(
                &app.path()
                    .app_cache_dir()
                    .map_err(|error| error.to_string())?,
                &profile.id,
            ));
        #[cfg(not(test))]
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

        let mut command_args = Vec::new();

        #[cfg(windows)]
        command_args.extend([
            "mount".to_string(),
            remote.clone(),
            profile.mount_target.clone(),
            "--volname".to_string(),
            profile.name.clone(),
            "--vfs-cache-mode".to_string(),
            "writes".to_string(),
        ]);

        #[cfg(target_os = "macos")]
        let nfs_port = {
            let port = free_port()?;
            command_args.extend([
                "serve".to_string(),
                "nfs".to_string(),
                remote.clone(),
                "--addr".to_string(),
                format!("127.0.0.1:{port}"),
                "--vfs-cache-mode".to_string(),
                "full".to_string(),
            ]);
            port
        };

        #[cfg(not(any(windows, target_os = "macos")))]
        return Err("Remote Drives currently support Windows and macOS only.".to_string());

        command_args.extend([
            "--cache-dir".to_string(),
            cache_dir.to_string_lossy().into_owned(),
            "--rc".to_string(),
            "--rc-addr".to_string(),
            format!("127.0.0.1:{rc_port}"),
        ]);
        let mut command = rclone_command(&rclone, &rclone_environment, command_args);
        command
            .env("RCLONE_RC_USER", &rc_user)
            .env("RCLONE_RC_PASS", &rc_pass)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));

        let mut child = command
            .spawn()
            .map_err(|error| format!("Failed to start rclone: {error}"))?;
        if let Err(error) = wait_for_rc(
            &mut child,
            &rclone,
            &rclone_environment,
            &rc_url,
            &rc_user,
            &rc_pass,
        ) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }

        #[cfg(target_os = "macos")]
        if !self.using_test_runtime()
            && let Err(error) = macos_mount(&profile.id, &profile.mount_target, nfs_port)
        {
            let _ = rc_call(
                &rclone,
                &rclone_environment,
                &rc_url,
                &rc_user,
                &rc_pass,
                "core/quit",
            );
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }

        let running = RunningMount {
            child,
            rclone,
            rc_url,
            rc_user,
            rc_pass,
            mount_path: mount_path.clone(),
            rclone_environment,
        };
        self.mounts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(profile.id.clone(), running);
        Ok(connected_status(&profile.id, &mount_path))
    }

    pub fn disconnect<R: Runtime>(
        &self,
        app: &AppHandle<R>,
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
        if !self.using_test_runtime()
            && let Err(error) =
                macos_unmount(id, mount.mount_path.to_string_lossy().as_ref(), force)
        {
            self.mounts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(id.to_string(), mount);
            return Err(error);
        }

        let _ = rc_call(
            &mount.rclone,
            &mount.rclone_environment,
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

    pub fn disconnect_all<R: Runtime>(&self, app: &AppHandle<R>) {
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

    pub fn disconnect_all_if_clean<R: Runtime>(&self, app: &AppHandle<R>) -> bool {
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
                    if result.status.error.is_some() {
                        blocker.error = result.status.error;
                    }
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

fn find_rclone<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
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
        .find(|candidate| rclone_version(candidate, &RcloneProcessEnvironment::default()).is_ok())
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

fn rclone_command(
    rclone: &Path,
    environment: &RcloneProcessEnvironment,
    args: impl IntoIterator<Item = String>,
) -> Command {
    let args: Vec<String> = args.into_iter().collect();
    let mut command = Command::new(rclone);
    if environment.command_prefix.is_empty() {
        command.args(args);
    } else {
        command
            .args(&environment.command_prefix)
            .env("EXPLORIE_FAKE_RCLONE", "1")
            .env(
                "EXPLORIE_FAKE_RCLONE_ARGS",
                serde_json::to_string(&args).expect("rclone arguments are serializable"),
            );
        if let Some(path) = &environment.control_file {
            command.env("EXPLORIE_FAKE_RCLONE_CONTROL", path);
        }
        if let Some(path) = &environment.state_file {
            command.env("EXPLORIE_FAKE_RCLONE_STATE", path);
        }
        if let Some(path) = &environment.attempt_file {
            command.env("EXPLORIE_FAKE_RCLONE_ATTEMPTS", path);
        }
        if let Some(path) = &environment.alive_file {
            command.env("EXPLORIE_FAKE_RCLONE_ALIVE", path);
        }
        if let Some(path) = &environment.response_file {
            command.env("EXPLORIE_FAKE_RCLONE_RESPONSE", path);
        }
        if let Some(attempts) = environment.fail_attempts {
            command.env("EXPLORIE_FAKE_RCLONE_FAIL_ATTEMPTS", attempts.to_string());
        }
    }
    command
}

fn read_fake_response(
    environment: &RcloneProcessEnvironment,
    fallback: &[u8],
) -> Result<Vec<u8>, String> {
    let Some(path) = &environment.response_file else {
        return Ok(fallback.to_vec());
    };
    let response = fs::read(path).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(path);
    Ok(response)
}

fn rclone_version(rclone: &Path, environment: &RcloneProcessEnvironment) -> Result<String, String> {
    let output = rclone_command(rclone, environment, ["version".to_string()])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("rclone version check failed".to_string());
    }
    let stdout = read_fake_response(environment, &output.stdout)?;
    String::from_utf8_lossy(&stdout)
        .lines()
        .next()
        .map(str::to_string)
        .ok_or_else(|| "rclone version check returned no output".to_string())
}

fn ensure_rclone_capabilities(
    rclone: &Path,
    environment: &RcloneProcessEnvironment,
) -> Result<(), String> {
    let args = if cfg!(target_os = "macos") {
        vec!["serve", "nfs", "--help"]
    } else {
        vec!["mount", "--help"]
    };
    let status = rclone_command(rclone, environment, args.into_iter().map(str::to_string))
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
    environment: &RcloneProcessEnvironment,
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
        if rc_call(rclone, environment, url, user, pass, "rc/noopauth").is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err("Timed out waiting for rclone to start.".to_string())
}

fn rc_call(
    rclone: &Path,
    environment: &RcloneProcessEnvironment,
    url: &str,
    user: &str,
    pass: &str,
    endpoint: &str,
) -> Result<Value, String> {
    let mut child = rclone_command(
        rclone,
        environment,
        [
            "rc".to_string(),
            "--url".to_string(),
            url.to_string(),
            endpoint.to_string(),
        ],
    )
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
    let stdout = read_fake_response(environment, &output.stdout)?;
    serde_json::from_slice(&stdout).map_err(|error| error.to_string())
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
        &mount.rclone_environment,
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

fn emit_status<R: Runtime>(app: &AppHandle<R>, status: RemoteDriveStatus) {
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

    #[cfg(any(windows, target_os = "macos"))]
    struct HarnessDir(PathBuf);

    #[cfg(any(windows, target_os = "macos"))]
    impl HarnessDir {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("explorie-remote-drive-harness-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    impl Drop for HarnessDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn fake_fixture(
        fail_attempts: u32,
        pending_uploads: u64,
        errored_files: u64,
    ) -> (HarnessDir, RemoteDriveManager, RemoteDriveProfile, PathBuf) {
        let directory = HarnessDir::new();
        let state_file = directory.0.join("vfs-state");
        let attempt_file = directory.0.join("attempts");
        let control_file = directory.0.join("quit");
        let alive_file = directory.0.join("alive");
        let response_file = directory.0.join("response.json");
        fs::write(&state_file, format!("{pending_uploads} {errored_files}")).unwrap();
        fs::write(&attempt_file, "0").unwrap();

        let environment = RcloneProcessEnvironment {
            command_prefix: vec!["fake_rclone_process".to_string()],
            control_file: Some(control_file.clone()),
            state_file: Some(state_file),
            attempt_file: Some(attempt_file.clone()),
            fail_attempts: Some(fail_attempts),
            alive_file: Some(alive_file),
            response_file: Some(response_file.clone()),
        };
        let manager = RemoteDriveManager::with_test_runtime(
            std::env::current_exe().unwrap(),
            directory.0.join("cache"),
            directory.0.join("mount-target"),
            environment,
        );

        #[cfg(windows)]
        let mount_target = "R:".to_string();
        #[cfg(target_os = "macos")]
        let mount_target = "ExplorieSmoke".to_string();
        let profile = RemoteDriveProfile {
            id: Uuid::new_v4().to_string(),
            name: "Fixture Drive".to_string(),
            remote: "local".to_string(),
            remote_path: "fixture".to_string(),
            mount_target,
        };
        (directory, manager, profile, attempt_file)
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn set_fake_state(directory: &HarnessDir, pending_uploads: u64, errored_files: u64) {
        fs::write(
            directory.0.join("vfs-state"),
            format!("{pending_uploads} {errored_files}"),
        )
        .unwrap();
    }

    #[cfg(windows)]
    fn process_is_running(pid: u32) -> bool {
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).lines().any(|line| {
            line.split_whitespace()
                .any(|field| field == pid.to_string())
        })
    }

    #[cfg(target_os = "macos")]
    fn process_is_running(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn wait_for_process(pid: u32, expected: bool) {
        for _ in 0..100 {
            if process_is_running(pid) == expected {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(process_is_running(pid), expected);
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn increment_counter(path: &Path) -> u32 {
        let current = fs::read_to_string(path)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .unwrap_or(0)
            + 1;
        fs::write(path, current.to_string()).unwrap();
        current
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn fake_response(path: &Path, value: &[u8]) {
        fs::write(path, value).unwrap();
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn fake_rclone_process() {
        if std::env::var_os("EXPLORIE_FAKE_RCLONE").is_none() {
            return;
        }
        let args: Vec<String> =
            serde_json::from_str(&std::env::var("EXPLORIE_FAKE_RCLONE_ARGS").unwrap()).unwrap();
        let response = PathBuf::from(std::env::var("EXPLORIE_FAKE_RCLONE_RESPONSE").unwrap());

        if args == ["version"] {
            fake_response(&response, b"rclone v1.74.4\n");
            return;
        }
        if args.first().is_some_and(|arg| arg == "listremotes") {
            fake_response(&response, b"local:\n");
            return;
        }
        if args.iter().any(|arg| arg == "--help") {
            return;
        }
        if args.first().is_some_and(|arg| arg == "rc") {
            let endpoint = args.last().map(String::as_str).unwrap_or_default();
            match endpoint {
                "rc/noopauth" => {
                    let alive = PathBuf::from(std::env::var("EXPLORIE_FAKE_RCLONE_ALIVE").unwrap());
                    if alive.is_file() {
                        fake_response(&response, b"{}");
                    }
                }
                "vfs/stats" => {
                    let state =
                        fs::read_to_string(std::env::var("EXPLORIE_FAKE_RCLONE_STATE").unwrap())
                            .unwrap();
                    let mut values = state.split_whitespace();
                    let pending = values.next().unwrap_or("0");
                    let errors = values.next().unwrap_or("0");
                    fake_response(
                        &response,
                        format!(
                            "{{\"diskCache\":{{\"uploadsQueued\":{pending},\"uploadsInProgress\":0,\"erroredFiles\":{errors}}}}}"
                        )
                        .as_bytes(),
                    );
                }
                "core/quit" => {
                    fs::write(
                        std::env::var("EXPLORIE_FAKE_RCLONE_CONTROL").unwrap(),
                        "quit",
                    )
                    .unwrap();
                    fake_response(&response, b"{}");
                }
                _ => fake_response(&response, b"{}"),
            }
            return;
        }

        let attempt = increment_counter(Path::new(
            &std::env::var("EXPLORIE_FAKE_RCLONE_ATTEMPTS").unwrap(),
        ));
        let fail_attempts = std::env::var("EXPLORIE_FAKE_RCLONE_FAIL_ATTEMPTS")
            .unwrap()
            .parse::<u32>()
            .unwrap();
        if attempt <= fail_attempts {
            std::process::exit(17);
        }

        let alive = PathBuf::from(std::env::var("EXPLORIE_FAKE_RCLONE_ALIVE").unwrap());
        fs::write(&alive, std::process::id().to_string()).unwrap();
        let control = PathBuf::from(std::env::var("EXPLORIE_FAKE_RCLONE_CONTROL").unwrap());
        while !control.is_file() {
            thread::sleep(Duration::from_millis(10));
        }
        let _ = fs::remove_file(alive);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn lifecycle_harness_retries_and_cleans_child_on_disconnect() {
        let (directory, manager, profile, attempt_file) = fake_fixture(2, 0, 0);
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let events_for_listener = Arc::clone(&events);
        let listener = handle.listen("remote-drive-status", move |event| {
            events_for_listener
                .lock()
                .unwrap()
                .push(event.payload().to_string());
        });

        let connected = manager.connect(&handle, profile.clone()).unwrap();
        assert_eq!(connected.state, "connected");
        assert_eq!(manager.statuses()[0].state, "connected");
        assert!(manager.is_mount_root(Path::new(connected.mount_path.as_deref().unwrap())));
        assert_eq!(fs::read_to_string(attempt_file).unwrap().trim(), "3");

        let pid = manager.test_child_ids()[0];
        wait_for_process(pid, true);
        let result = manager.disconnect(&handle, &profile.id, false).unwrap();
        assert!(!result.blocked);
        assert_eq!(result.status.state, "disconnected");
        wait_for_process(pid, false);
        assert!(manager.statuses().is_empty());
        assert!(!manager.is_mount_root(Path::new(connected.mount_path.as_deref().unwrap())));
        assert!(!directory.0.join("alive").is_file());
        handle.unlisten(listener);
        let states: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .map(|payload| serde_json::from_str::<Value>(payload).unwrap()["state"].to_string())
            .collect();
        assert_eq!(
            states,
            vec![
                "\"connecting\"",
                "\"connected\"",
                "\"disconnecting\"",
                "\"disconnected\""
            ]
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn lifecycle_harness_gives_up_after_bounded_retries() {
        let (directory, manager, profile, attempt_file) = fake_fixture(9, 0, 0);
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let events_for_listener = Arc::clone(&events);
        let listener = handle.listen("remote-drive-status", move |event| {
            events_for_listener
                .lock()
                .unwrap()
                .push(event.payload().to_string());
        });

        let error = manager.connect(&handle, profile).unwrap_err();
        assert!(error.contains("rclone exited before the mount was ready"));
        assert_eq!(fs::read_to_string(attempt_file).unwrap().trim(), "3");
        assert!(manager.statuses().is_empty());
        assert!(!directory.0.join("alive").is_file());
        handle.unlisten(listener);
        let states: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .map(|payload| serde_json::from_str::<Value>(payload).unwrap()["state"].to_string())
            .collect();
        assert_eq!(states, vec!["\"connecting\"", "\"error\""]);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn lifecycle_harness_reports_pending_uploads_and_blocks_exit_until_clean() {
        let (directory, manager, profile, _) = fake_fixture(0, 2, 1);
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let exit_events = Arc::new(Mutex::new(Vec::<String>::new()));
        let exit_events_for_listener = Arc::clone(&exit_events);
        let exit_listener = handle.listen("remote-drive-exit-blocked", move |event| {
            exit_events_for_listener
                .lock()
                .unwrap()
                .push(event.payload().to_string());
        });
        manager.connect(&handle, profile.clone()).unwrap();
        let pid = manager.test_child_ids()[0];
        wait_for_process(pid, true);

        let blocked = manager.disconnect(&handle, &profile.id, false).unwrap();
        assert!(blocked.blocked);
        assert_eq!(blocked.pending_uploads, 2);
        assert_eq!(blocked.errored_files, 1);
        assert!(!manager.disconnect_all_if_clean(&handle));
        assert_eq!(manager.test_child_ids(), vec![pid]);
        wait_for_process(pid, true);
        let blocker: Value = serde_json::from_str(&exit_events.lock().unwrap()[0]).unwrap();
        assert_eq!(blocker["pendingUploads"], 2);
        assert_eq!(blocker["erroredFiles"], 1);

        set_fake_state(&directory, 0, 0);
        assert!(manager.disconnect_all_if_clean(&handle));
        wait_for_process(pid, false);
        assert!(manager.statuses().is_empty());
        let mount_path = directory.0.join("mount-target");
        assert!(!manager.is_mount_root(&mount_path));
        handle.unlisten(exit_listener);
    }

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
