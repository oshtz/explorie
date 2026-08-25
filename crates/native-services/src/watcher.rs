use crate::{
    ErrorCode, ServiceContext, ServiceError, ServiceEvent, ServiceResult, WatcherEvent,
    WatcherState,
};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::thread;
use std::time::Duration;

pub const COALESCE_DELAY: Duration = Duration::from_millis(200);

#[derive(Clone)]
pub struct WatcherService {
    context: ServiceContext,
    inner: Arc<WatcherInner>,
}

struct WatcherInner {
    next_id: AtomicU64,
    registrations: Mutex<HashMap<String, Registration>>,
    subscriptions: Mutex<HashMap<u64, WatchSubscription>>,
}

struct Registration {
    _watcher: notify::RecommendedWatcher,
    subscribers: HashMap<u64, mpsc::Sender<Result<Event, String>>>,
}

pub struct WatchSubscription {
    inner: Weak<WatcherInner>,
    keys: Vec<String>,
    paths: Vec<PathBuf>,
    cancelled: Arc<AtomicBool>,
    id: u64,
}

impl WatcherService {
    pub(crate) fn new(context: ServiceContext) -> Self {
        Self {
            context,
            inner: Arc::new(WatcherInner {
                next_id: AtomicU64::new(0),
                registrations: Mutex::new(HashMap::new()),
                subscriptions: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Register one non-recursive native watcher for a normalized path set.
    /// Equal paths share one OS watcher while each subscription gets its own
    /// coalescing worker.
    pub fn watch(&self, paths: Vec<PathBuf>) -> ServiceResult<WatchSubscription> {
        let paths = normalize_paths(paths);
        if paths.is_empty() {
            return Err(ServiceError::new(
                ErrorCode::InvalidInput,
                "At least one path is required for a filesystem watcher",
            ));
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let keys: Vec<String> = paths.iter().map(|path| normalize_path(path)).collect();
        let cancelled = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::channel();
        let mut registrations = self
            .inner
            .registrations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for (path, key) in paths.iter().zip(&keys) {
            if let Some(registration) = registrations.get_mut(key) {
                registration.subscribers.insert(id, sender.clone());
                continue;
            }

            let callback_inner = Arc::downgrade(&self.inner);
            let callback_key = key.clone();
            let watcher =
                match notify::recommended_watcher(move |event: Result<Event, notify::Error>| {
                    let Some(inner) = callback_inner.upgrade() else {
                        return;
                    };
                    let event = event.map_err(|error| error.to_string());
                    let mut registrations = inner
                        .registrations
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let Some(registration) = registrations.get_mut(&callback_key) else {
                        return;
                    };
                    registration
                        .subscribers
                        .retain(|_, subscriber| subscriber.send(event.clone()).is_ok());
                }) {
                    Ok(watcher) => watcher,
                    Err(error) => {
                        for rollback_key in &keys {
                            if let Some(registration) = registrations.get_mut(rollback_key) {
                                registration.subscribers.remove(&id);
                            }
                        }
                        registrations
                            .retain(|_, registration| !registration.subscribers.is_empty());
                        return Err(watcher_error("create filesystem watcher", error));
                    }
                };
            let mut watcher = watcher;
            if let Err(error) = watcher.watch(path, RecursiveMode::NonRecursive) {
                for rollback_key in &keys {
                    if let Some(registration) = registrations.get_mut(rollback_key) {
                        registration.subscribers.remove(&id);
                    }
                }
                registrations.retain(|_, registration| !registration.subscribers.is_empty());
                return Err(watcher_error("register filesystem watcher", error));
            }
            let mut subscribers = HashMap::new();
            subscribers.insert(id, sender.clone());
            registrations.insert(
                key.clone(),
                Registration {
                    _watcher: watcher,
                    subscribers,
                },
            );
        }

        let events = self.context.events();
        let worker_paths = paths.clone();
        let worker_cancelled = Arc::clone(&cancelled);
        thread::spawn(move || {
            coalescing_worker(id, worker_paths, receiver, events, worker_cancelled)
        });
        Ok(WatchSubscription {
            inner: Arc::downgrade(&self.inner),
            keys,
            paths,
            cancelled,
            id,
        })
    }

    /// Register a watcher owned by this service. This is the command/host
    /// form of [`watch`](Self::watch): the registration remains alive until
    /// [`unwatch`](Self::unwatch) is called.
    pub fn watch_paths(&self, paths: Vec<PathBuf>) -> ServiceResult<u64> {
        let subscription = self.watch(paths)?;
        let id = subscription.id();
        self.inner
            .subscriptions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(id, subscription);
        Ok(id)
    }

    /// Register a host-owned watcher without running notify setup on the
    /// caller's executor.
    pub fn watch_paths_task(&self, paths: Vec<PathBuf>) -> crate::BlockingTask<u64> {
        let service = self.clone();
        self.context
            .spawn_blocking(move || service.watch_paths(paths))
    }

    /// Drop a host-owned watcher and publish its terminal status.
    pub fn unwatch(&self, id: u64) -> bool {
        let subscription = self
            .inner
            .subscriptions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id);
        let Some(subscription) = subscription else {
            return false;
        };
        subscription.cancelled.store(true, Ordering::Release);
        self.context
            .events()
            .publish(ServiceEvent::Watcher(WatcherEvent {
                registration_id: id,
                state: WatcherState::Stopped,
                paths: subscription.paths.clone(),
                error: None,
            }));
        drop(subscription);
        true
    }

    pub fn unwatch_task(&self, id: u64) -> crate::BlockingTask<bool> {
        let service = self.clone();
        self.context.spawn_blocking(move || Ok(service.unwatch(id)))
    }

    pub fn registration_count(&self) -> usize {
        self.inner
            .registrations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }
}

impl WatchSubscription {
    pub fn id(&self) -> u64 {
        self.id
    }
}

impl Drop for WatchSubscription {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let mut registrations = inner
            .registrations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for key in &self.keys {
            let remove = registrations.get_mut(key).is_some_and(|registration| {
                registration.subscribers.remove(&self.id);
                registration.subscribers.is_empty()
            });
            if remove {
                registrations.remove(key);
            }
        }
    }
}

fn coalescing_worker(
    id: u64,
    watched_paths: Vec<PathBuf>,
    receiver: mpsc::Receiver<Result<Event, String>>,
    events: crate::ServiceEvents,
    cancelled: Arc<AtomicBool>,
) {
    while let Ok(first) = receiver.recv() {
        if cancelled.load(Ordering::Acquire) {
            return;
        }
        let mut changed = HashSet::new();
        if let Err(error) = collect_event(first, &mut changed) {
            events.publish(ServiceEvent::Watcher(WatcherEvent {
                registration_id: id,
                state: WatcherState::Failed,
                paths: watched_paths,
                error: Some(error),
            }));
            return;
        }

        while let Ok(next) = receiver.recv_timeout(COALESCE_DELAY) {
            if cancelled.load(Ordering::Acquire) {
                return;
            }
            if let Err(error) = collect_event(next, &mut changed) {
                events.publish(ServiceEvent::Watcher(WatcherEvent {
                    registration_id: id,
                    state: WatcherState::Failed,
                    paths: Vec::new(),
                    error: Some(error),
                }));
                return;
            }
        }

        if !cancelled.load(Ordering::Acquire) && !changed.is_empty() {
            let mut paths: Vec<_> = changed.into_iter().collect();
            paths.sort();
            events.publish(ServiceEvent::Watcher(WatcherEvent {
                registration_id: id,
                state: WatcherState::Changed,
                paths,
                error: None,
            }));
        }
    }
}

fn collect_event(
    event: Result<Event, String>,
    changed: &mut HashSet<PathBuf>,
) -> ServiceResult<()> {
    let event = event.map_err(|error| watcher_message("receive filesystem event", error))?;
    if is_access_only(&event.kind) {
        return Ok(());
    }
    changed.extend(event.paths);
    Ok(())
}

fn is_access_only(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Access(_))
}

fn normalize_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut keyed = paths
        .into_iter()
        .map(|path| (normalize_path(&path), path))
        .collect::<HashMap<_, _>>();
    let mut values: Vec<_> = keyed.drain().map(|(_, path)| path).collect();
    values.sort_by_key(|path| normalize_path(path));
    values
}

fn normalize_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.trim_end_matches('/').to_ascii_lowercase()
    } else {
        value.trim_end_matches('/').to_string()
    }
}

fn watcher_error(operation: &str, error: notify::Error) -> ServiceError {
    watcher_message(operation, error.to_string())
}

fn watcher_message(operation: &str, error: String) -> ServiceError {
    ServiceError::new(ErrorCode::Io, format!("Failed to {operation}: {error}"))
        .retryable(true)
        .operation("watch")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NativeServices, ResourcePaths, ServiceEvent, WatcherState};
    use std::fs;

    #[test]
    fn registrations_are_deduplicated_and_access_events_are_ignored() {
        let temp = tempfile::tempdir().unwrap();
        let services = NativeServices::new(ResourcePaths::test(temp.path()));
        let receiver = services.subscribe();
        let first = services
            .watcher
            .watch(vec![temp.path().to_path_buf(), temp.path().to_path_buf()])
            .unwrap();
        let second = services
            .watcher
            .watch(vec![temp.path().to_path_buf()])
            .unwrap();
        assert_ne!(first.id(), second.id());
        assert_eq!(services.watcher.registration_count(), 1);
        drop(second);
        assert_eq!(services.watcher.registration_count(), 1);

        fs::write(temp.path().join("changed.txt"), "changed").unwrap();
        let event = receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("native change event");
        match event {
            ServiceEvent::Watcher(event) => {
                assert_eq!(event.state, WatcherState::Changed);
                assert!(event.paths.iter().any(|path| path.ends_with("changed.txt")));
            }
            other => panic!("unexpected service event: {other:?}"),
        }
        drop(first);
        assert_eq!(services.watcher.registration_count(), 0);
    }

    #[test]
    fn access_only_events_do_not_mark_a_path_changed() {
        assert!(is_access_only(&EventKind::Access(
            notify::event::AccessKind::Read
        )));
        assert!(!is_access_only(&EventKind::Modify(
            notify::event::ModifyKind::Any
        )));
    }

    #[test]
    fn host_owned_watchers_can_be_registered_and_stopped() {
        let temp = tempfile::tempdir().unwrap();
        let services = NativeServices::new(ResourcePaths::test(temp.path()));
        let receiver = services.subscribe();
        let id = services
            .watcher
            .watch_paths(vec![temp.path().to_path_buf()])
            .unwrap();
        assert_eq!(services.watcher.registration_count(), 1);
        assert!(services.watcher.unwatch(id));
        assert_eq!(services.watcher.registration_count(), 0);
        match receiver.recv_timeout(Duration::from_secs(1)).unwrap() {
            ServiceEvent::Watcher(event) => {
                assert_eq!(event.registration_id, id);
                assert_eq!(event.state, WatcherState::Stopped);
            }
            other => panic!("unexpected service event: {other:?}"),
        }
        assert!(!services.watcher.unwatch(id));
    }
}
