use explorie_desktop::remote_drives::{RemoteDriveManager, RemoteDriveProfile};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

static HARNESS: Mutex<()> = Mutex::new(());
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Fixture {
    _lock: std::sync::MutexGuard<'static, ()>,
    _cache: TempDir,
    state: TempDir,
    events: PathBuf,
    manager: RemoteDriveManager,
}

impl Fixture {
    fn new(fail_spawns: u32, vfs_stats: &str) -> Self {
        let lock = HARNESS.lock().unwrap_or_else(|error| error.into_inner());
        let cache = TempDir::new("explorie-rd-cache");
        let state = TempDir::new("explorie-rd-state");
        let events = cache.0.join("events.log");
        let fake = std::env::current_exe().expect("test executable");
        unsafe {
            std::env::set_var("EXPLORIE_FAKE_RCLONE", &fake);
            std::env::set_var("EXPLORIE_REMOTE_DRIVE_TEST_CACHE", &cache.0);
            std::env::set_var("EXPLORIE_REMOTE_DRIVE_TEST_EVENTS", &events);
            std::env::set_var("EXPLORIE_FAKE_RCLONE_STATE", &state.0);
            std::env::set_var("EXPLORIE_FAKE_RCLONE_REMOTES", "cloud");
            std::env::set_var("EXPLORIE_FAKE_RCLONE_FAIL_SPAWNS", fail_spawns.to_string());
            std::env::set_var("EXPLORIE_FAKE_RCLONE_VFS_STATS", vfs_stats);
            std::env::set_var("RCLONE_CONFIG", cache.0.join("missing-rclone.conf"));
        }
        Self {
            _lock: lock,
            _cache: cache,
            state,
            events,
            manager: RemoteDriveManager::default(),
        }
    }

    fn profile(&self) -> RemoteDriveProfile {
        RemoteDriveProfile {
            id: format!(
                "00000000-0000-4000-8000-{:012x}",
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ),
            name: "Fake Drive".to_string(),
            remote: "cloud".to_string(),
            remote_path: String::new(),
            mount_target: free_mount_target(),
        }
    }

    fn event_states(&self) -> Vec<String> {
        fs::read_to_string(&self.events)
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn spawn_count(&self) -> u32 {
        fs::read_to_string(self.state.0.join("spawns"))
            .ok()
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(0)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for status in self.manager.statuses() {
            let _ = self.manager.test_disconnect(&status.id, true);
        }
        unsafe {
            std::env::remove_var("EXPLORIE_FAKE_RCLONE");
            std::env::remove_var("EXPLORIE_REMOTE_DRIVE_TEST_CACHE");
            std::env::remove_var("EXPLORIE_REMOTE_DRIVE_TEST_EVENTS");
            std::env::remove_var("EXPLORIE_FAKE_RCLONE_STATE");
            std::env::remove_var("EXPLORIE_FAKE_RCLONE_REMOTES");
            std::env::remove_var("EXPLORIE_FAKE_RCLONE_FAIL_SPAWNS");
            std::env::remove_var("EXPLORIE_FAKE_RCLONE_VFS_STATS");
            std::env::remove_var("RCLONE_CONFIG");
        }
    }
}

fn free_mount_target() -> String {
    #[cfg(windows)]
    {
        for letter in b'D'..=b'Z' {
            let target = format!("{}:", char::from(letter));
            let root = PathBuf::from(format!("{target}\\"));
            if !root.try_exists().unwrap_or(true) {
                return target;
            }
        }
        panic!("no unused Windows drive letter for remote-drive tests");
    }
    #[cfg(target_os = "macos")]
    {
        format!("ExplorieFake{}", std::process::id() % 100_000)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        "test".to_string()
    }
}

fn pid_running(pid: u32) -> bool {
    #[cfg(windows)]
    {
        Command::new("tasklist")
            .args(["/NH", "/FI", &format!("PID eq {pid}")])
            .output()
            .ok()
            .is_some_and(|output| {
                String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
            })
    }
    #[cfg(unix)]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        false
    }
}

fn assert_pid_gone(pid: u32) {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(2) {
        if !pid_running(pid) {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("rclone child {pid} was still running");
}

#[cfg(any(windows, target_os = "macos"))]
fn connect_emits_status_transitions_reports_pending_uploads_and_cleans_child() {
    let fixture = Fixture::new(
        0,
        r#"{"diskCache":{"uploadsQueued":2,"uploadsInProgress":1,"erroredFiles":1}}"#,
    );
    let profile = fixture.profile();
    let connected = fixture
        .manager
        .test_connect(profile.clone())
        .expect("connect");
    assert_eq!(connected.state, "connected");
    assert_eq!(fixture.event_states(), ["connecting", "connected"]);
    let pid = fixture
        .manager
        .child_pid(&profile.id)
        .expect("fake rclone child");
    assert!(pid_running(pid), "manager must keep the child it started");

    let blocked = fixture
        .manager
        .test_disconnect(&profile.id, false)
        .expect("pending disconnect");
    assert!(blocked.blocked);
    assert_eq!(blocked.pending_uploads, 3);
    assert_eq!(blocked.errored_files, 1);
    assert!(!fixture.manager.test_disconnect_all_if_clean());

    let forced = fixture
        .manager
        .test_disconnect(&profile.id, true)
        .expect("force disconnect");
    assert!(!forced.blocked);
    assert_eq!(forced.status.state, "disconnected");
    assert!(fixture.manager.statuses().is_empty());
    let states = fixture.event_states();
    assert!(states.ends_with(&["disconnecting".to_string(), "disconnected".to_string()]));
    assert_pid_gone(pid);
    assert!(fixture.manager.test_disconnect_all_if_clean());
}

#[cfg(any(windows, target_os = "macos"))]
fn connect_retries_transient_child_failures_then_succeeds() {
    let fixture = Fixture::new(
        2,
        r#"{"diskCache":{"uploadsQueued":0,"uploadsInProgress":0,"erroredFiles":0}}"#,
    );
    let profile = fixture.profile();
    let connected = fixture
        .manager
        .test_connect(profile.clone())
        .expect("retry connect");
    assert_eq!(connected.state, "connected");
    assert_eq!(fixture.spawn_count(), 3);
    let pid = fixture.manager.child_pid(&profile.id).expect("child");
    fixture.manager.test_disconnect(&profile.id, true).unwrap();
    assert_pid_gone(pid);
    assert!(fixture.manager.statuses().is_empty());
}

#[cfg(any(windows, target_os = "macos"))]
fn connect_gives_up_after_bounded_retries() {
    let fixture = Fixture::new(
        99,
        r#"{"diskCache":{"uploadsQueued":0,"uploadsInProgress":0,"erroredFiles":0}}"#,
    );
    let profile = fixture.profile();
    let error = fixture
        .manager
        .test_connect(profile.clone())
        .expect_err("give-up");
    assert!(error.contains("fake rclone spawn") || error.contains("exited before the mount"));
    assert_eq!(fixture.spawn_count(), 3);
    assert!(fixture.manager.statuses().is_empty());
    assert_eq!(fixture.manager.child_pid(&profile.id), None);
    assert_eq!(fixture.event_states(), ["connecting", "error"]);
}

fn is_fake_rclone_invocation() -> bool {
    std::env::args().nth(1).is_some_and(|arg| {
        matches!(
            arg.as_str(),
            "version" | "listremotes" | "rc" | "mount" | "serve" | "--help"
        )
    })
}

fn main() {
    if is_fake_rclone_invocation() {
        explorie_desktop::remote_drives::run_fake_rclone();
        return;
    }

    #[cfg(any(windows, target_os = "macos"))]
    {
        eprintln!(
            "test connect_emits_status_transitions_reports_pending_uploads_and_cleans_child ..."
        );
        connect_emits_status_transitions_reports_pending_uploads_and_cleans_child();
        eprintln!("ok");
        eprintln!("test connect_retries_transient_child_failures_then_succeeds ...");
        connect_retries_transient_child_failures_then_succeeds();
        eprintln!("ok");
        eprintln!("test connect_gives_up_after_bounded_retries ...");
        connect_gives_up_after_bounded_retries();
        eprintln!("ok");
    }
}
