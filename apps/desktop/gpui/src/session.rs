use std::fs::{self, File};
use std::io::{self, Write};
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};

use serde::{Deserialize, Serialize};

use crate::browser::BrowserState;
use crate::{EntryFilter, SortDirection, SortKey, ViewMode};
use explorie_native_services::SearchCriteria;

const RECENT_LIMIT: usize = 5;
const GO_TO_FOLDER_RECENT_LIMIT: usize = 10;
const SESSION_VERSION: u32 = 1;
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TabId(u64);

impl TabId {
    pub fn value(self) -> u64 {
        self.0
    }
}

#[derive(Debug)]
pub struct TabState {
    id: TabId,
    browser: BrowserState,
}

impl TabState {
    pub fn id(&self) -> TabId {
        self.id
    }

    pub fn path(&self) -> &Path {
        self.browser.path()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Favorite {
    path: PathBuf,
    name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartFolder {
    id: u64,
    name: String,
    criteria: SearchCriteria,
}

impl SmartFolder {
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn criteria(&self) -> &SearchCriteria {
        &self.criteria
    }
}

impl Favorite {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

#[derive(Debug)]
pub struct SessionState {
    tabs: Vec<TabState>,
    active: usize,
    next_tab_id: u64,
    favorites: Vec<Favorite>,
    recents: Vec<PathBuf>,
    go_to_folder_recents: Vec<PathBuf>,
    smart_folders: Vec<SmartFolder>,
    active_smart_folder_id: Option<u64>,
    next_smart_folder_id: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredTab {
    id: u64,
    path: PathBuf,
    #[serde(default)]
    back: Vec<PathBuf>,
    #[serde(default)]
    forward: Vec<PathBuf>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredFavorite {
    path: PathBuf,
    name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSnapshot {
    version: u32,
    tabs: Vec<StoredTab>,
    active_tab_id: u64,
    favorites: Vec<StoredFavorite>,
    recents: Vec<PathBuf>,
    #[serde(default)]
    go_to_folder_recents: Vec<PathBuf>,
    #[serde(default)]
    smart_folders: Vec<SmartFolder>,
    #[serde(default)]
    active_smart_folder_id: Option<u64>,
}

impl SessionState {
    pub fn new(path: PathBuf) -> Self {
        Self {
            tabs: vec![TabState {
                id: TabId(1),
                browser: BrowserState::new(path.clone()),
            }],
            active: 0,
            next_tab_id: 2,
            favorites: Vec::new(),
            recents: vec![path],
            go_to_folder_recents: Vec::new(),
            smart_folders: Vec::new(),
            active_smart_folder_id: None,
            next_smart_folder_id: 1,
        }
    }

    pub fn tabs(&self) -> &[TabState] {
        &self.tabs
    }

    pub fn workspace_tabs(&self) -> Vec<(String, PathBuf)> {
        self.tabs
            .iter()
            .map(|tab| (tab.id.0.to_string(), tab.path().to_path_buf()))
            .collect()
    }

    pub fn replace_workspace_tabs(
        &mut self,
        tabs: Vec<(String, PathBuf)>,
        active_tab_id: &str,
    ) -> Result<(), String> {
        if tabs.is_empty() {
            return Err("workspace has no available tabs".to_string());
        }
        let active = tabs
            .iter()
            .position(|(id, _)| id == active_tab_id)
            .unwrap_or(0);
        let mut next_id = self.next_tab_id;
        self.tabs = tabs
            .into_iter()
            .map(|(_, path)| {
                let id = TabId(next_id);
                next_id = next_id.wrapping_add(1).max(1);
                TabState {
                    id,
                    browser: BrowserState::new(path),
                }
            })
            .collect();
        self.active = active.min(self.tabs.len() - 1);
        self.next_tab_id = next_id;
        self.active_smart_folder_id = None;
        self.record_current_path();
        Ok(())
    }

    pub fn apply_browser_preferences(
        &mut self,
        show_hidden: bool,
        show_system_files: bool,
        filter: EntryFilter,
        sort_key: SortKey,
        sort_direction: SortDirection,
        view_mode: ViewMode,
    ) {
        for tab in &mut self.tabs {
            tab.browser.apply_preferences(
                show_hidden,
                show_system_files,
                filter,
                sort_key.clone(),
                sort_direction,
                view_mode,
            );
        }
    }

    pub fn active_tab_id(&self) -> TabId {
        self.tabs[self.active].id
    }

    pub fn new_tab(&mut self) -> TabId {
        let id = TabId(self.next_tab_id);
        self.next_tab_id = self.next_tab_id.wrapping_add(1).max(1);
        let browser = self.tabs[self.active].browser.fork_for_new_tab();
        self.tabs.push(TabState { id, browser });
        self.active = self.tabs.len() - 1;
        id
    }

    pub fn activate(&mut self, id: TabId) -> bool {
        let Some(index) = self.tabs.iter().position(|tab| tab.id == id) else {
            return false;
        };
        if index == self.active {
            return false;
        }
        self.active = index;
        true
    }

    pub fn activate_offset(&mut self, offset: isize) -> bool {
        if self.tabs.len() < 2 || offset == 0 {
            return false;
        }
        let count = self.tabs.len() as isize;
        let next = (self.active as isize + offset).rem_euclid(count) as usize;
        self.active = next;
        true
    }

    pub fn close(&mut self, id: TabId) -> bool {
        if self.tabs.len() == 1 {
            return false;
        }
        let Some(index) = self.tabs.iter().position(|tab| tab.id == id) else {
            return false;
        };
        let was_active = index == self.active;
        self.tabs.remove(index);
        if was_active {
            self.active = index.saturating_sub(1).min(self.tabs.len() - 1);
        } else if index < self.active {
            self.active -= 1;
        }
        true
    }

    pub fn reorder(&mut self, from: TabId, to: TabId) -> bool {
        if from == to {
            return false;
        }
        let Some(from_index) = self.tabs.iter().position(|tab| tab.id == from) else {
            return false;
        };
        let Some(to_index) = self.tabs.iter().position(|tab| tab.id == to) else {
            return false;
        };
        let active_id = self.active_tab_id();
        let tab = self.tabs.remove(from_index);
        self.tabs.insert(to_index, tab);
        self.active = self
            .tabs
            .iter()
            .position(|tab| tab.id == active_id)
            .expect("active tab remains present after reorder");
        true
    }

    pub fn move_active(&mut self, offset: isize) -> bool {
        let target = self.active.saturating_add_signed(offset);
        if target >= self.tabs.len() || target == self.active {
            return false;
        }
        let from = self.active_tab_id();
        let to = self.tabs[target].id;
        self.reorder(from, to)
    }

    pub fn record_current_path(&mut self) {
        let path = self.path().to_path_buf();
        self.recents.retain(|recent| !same_path(recent, &path));
        self.recents.insert(0, path);
        self.recents.truncate(RECENT_LIMIT);
    }

    pub fn recents(&self) -> &[PathBuf] {
        &self.recents
    }

    pub fn go_to_folder_recents(&self) -> &[PathBuf] {
        &self.go_to_folder_recents
    }

    pub fn record_go_to_folder(&mut self, path: PathBuf) {
        self.go_to_folder_recents
            .retain(|recent| !same_path(recent, &path));
        self.go_to_folder_recents.insert(0, path);
        self.go_to_folder_recents
            .truncate(GO_TO_FOLDER_RECENT_LIMIT);
    }

    pub fn seed_go_to_folder_recents(&mut self, paths: impl IntoIterator<Item = PathBuf>) {
        if !self.go_to_folder_recents.is_empty() {
            return;
        }
        for path in paths {
            if self
                .go_to_folder_recents
                .iter()
                .any(|recent| same_path(recent, &path))
            {
                continue;
            }
            self.go_to_folder_recents.push(path);
            if self.go_to_folder_recents.len() == GO_TO_FOLDER_RECENT_LIMIT {
                break;
            }
        }
    }

    pub fn favorites(&self) -> &[Favorite] {
        &self.favorites
    }

    pub fn is_favorite(&self, path: &Path) -> bool {
        self.favorites
            .iter()
            .any(|favorite| same_path(&favorite.path, path))
    }

    pub fn toggle_favorite(&mut self, path: PathBuf) -> bool {
        if let Some(index) = self
            .favorites
            .iter()
            .position(|favorite| same_path(&favorite.path, &path))
        {
            self.favorites.remove(index);
            return false;
        }
        let name = path
            .file_name()
            .unwrap_or_else(|| path.as_os_str())
            .to_string_lossy()
            .into_owned();
        self.favorites.push(Favorite { path, name });
        true
    }

    pub fn remove_favorite(&mut self, path: &Path) -> bool {
        let before = self.favorites.len();
        self.favorites
            .retain(|favorite| !same_path(&favorite.path, path));
        self.favorites.len() != before
    }

    pub fn reorder_favorite(&mut self, path: &Path, target_index: usize) -> bool {
        let Some(source_index) = self
            .favorites
            .iter()
            .position(|favorite| same_path(&favorite.path, path))
        else {
            return false;
        };
        let target_index = target_index.min(self.favorites.len().saturating_sub(1));
        if source_index == target_index {
            return false;
        }
        let favorite = self.favorites.remove(source_index);
        self.favorites.insert(target_index, favorite);
        true
    }

    pub fn smart_folders(&self) -> &[SmartFolder] {
        &self.smart_folders
    }

    pub fn active_smart_folder(&self) -> Option<&SmartFolder> {
        let id = self.active_smart_folder_id?;
        self.smart_folders.iter().find(|folder| folder.id == id)
    }

    pub fn save_smart_folder(&mut self, name: String, criteria: SearchCriteria) -> u64 {
        let id = self.next_smart_folder_id;
        self.next_smart_folder_id = self.next_smart_folder_id.wrapping_add(1).max(1);
        self.smart_folders.push(SmartFolder { id, name, criteria });
        id
    }

    pub fn update_smart_folder(&mut self, id: u64, name: String, criteria: SearchCriteria) -> bool {
        let Some(folder) = self.smart_folders.iter_mut().find(|folder| folder.id == id) else {
            return false;
        };
        folder.name = name;
        folder.criteria = criteria;
        true
    }

    pub fn activate_smart_folder(&mut self, id: u64) -> bool {
        if !self.smart_folders.iter().any(|folder| folder.id == id) {
            return false;
        }
        if self.active_smart_folder_id == Some(id) {
            return false;
        }
        self.active_smart_folder_id = Some(id);
        true
    }

    pub fn clear_active_smart_folder(&mut self) {
        self.active_smart_folder_id = None;
    }

    pub fn delete_smart_folder(&mut self, id: u64) -> bool {
        let before = self.smart_folders.len();
        self.smart_folders.retain(|folder| folder.id != id);
        if self.active_smart_folder_id == Some(id) {
            self.active_smart_folder_id = None;
        }
        self.smart_folders.len() != before
    }

    fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            version: SESSION_VERSION,
            tabs: self
                .tabs
                .iter()
                .map(|tab| StoredTab {
                    id: tab.id.0,
                    path: tab.browser.path().to_path_buf(),
                    back: tab.browser.back_history().to_vec(),
                    forward: tab.browser.forward_history().to_vec(),
                })
                .collect(),
            active_tab_id: self.active_tab_id().0,
            favorites: self
                .favorites
                .iter()
                .map(|favorite| StoredFavorite {
                    path: favorite.path.clone(),
                    name: favorite.name.clone(),
                })
                .collect(),
            recents: self.recents.clone(),
            go_to_folder_recents: self.go_to_folder_recents.clone(),
            smart_folders: self.smart_folders.clone(),
            active_smart_folder_id: self.active_smart_folder_id,
        }
    }

    fn from_snapshot(snapshot: SessionSnapshot) -> Result<Self, String> {
        if snapshot.version != SESSION_VERSION {
            return Err(format!(
                "unsupported session version {}; expected {SESSION_VERSION}",
                snapshot.version
            ));
        }
        if snapshot.tabs.is_empty() {
            return Err("session has no tabs".to_string());
        }
        let mut ids = std::collections::HashSet::with_capacity(snapshot.tabs.len());
        if snapshot
            .tabs
            .iter()
            .any(|tab| tab.id == 0 || !ids.insert(tab.id))
        {
            return Err("session contains invalid or duplicate tab identifiers".to_string());
        }
        let active = snapshot
            .tabs
            .iter()
            .position(|tab| tab.id == snapshot.active_tab_id)
            .unwrap_or(0);
        let next_tab_id = snapshot
            .tabs
            .iter()
            .map(|tab| tab.id)
            .max()
            .unwrap_or(0)
            .wrapping_add(1)
            .max(1);
        let tabs = snapshot
            .tabs
            .into_iter()
            .map(|tab| {
                let mut browser = BrowserState::new(tab.path);
                browser.restore_navigation_history(tab.back, tab.forward);
                TabState {
                    id: TabId(tab.id),
                    browser,
                }
            })
            .collect();
        let mut session = Self {
            tabs,
            active,
            next_tab_id,
            favorites: Vec::new(),
            recents: Vec::new(),
            go_to_folder_recents: Vec::new(),
            next_smart_folder_id: snapshot
                .smart_folders
                .iter()
                .map(|folder| folder.id)
                .max()
                .unwrap_or(0)
                .wrapping_add(1)
                .max(1),
            active_smart_folder_id: snapshot
                .active_smart_folder_id
                .filter(|id| snapshot.smart_folders.iter().any(|folder| folder.id == *id)),
            smart_folders: snapshot.smart_folders,
        };
        for favorite in snapshot.favorites {
            if session.is_favorite(&favorite.path) {
                continue;
            }
            let name = if favorite.name.trim().is_empty() {
                favorite
                    .path
                    .file_name()
                    .unwrap_or(favorite.path.as_os_str())
                    .to_string_lossy()
                    .into_owned()
            } else {
                favorite.name
            };
            session.favorites.push(Favorite {
                path: favorite.path,
                name,
            });
        }
        for recent in snapshot.recents {
            if session
                .recents
                .iter()
                .any(|existing| same_path(existing, &recent))
            {
                continue;
            }
            session.recents.push(recent);
            if session.recents.len() == RECENT_LIMIT {
                break;
            }
        }
        session.seed_go_to_folder_recents(snapshot.go_to_folder_recents);
        Ok(session)
    }
}

impl Deref for SessionState {
    type Target = BrowserState;

    fn deref(&self) -> &Self::Target {
        &self.tabs[self.active].browser
    }
}

impl DerefMut for SessionState {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.tabs[self.active].browser
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .replace('/', "\\")
            .eq_ignore_ascii_case(&right.to_string_lossy().replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

enum StoreMessage {
    Save(Vec<u8>),
    Flush(mpsc::SyncSender<()>),
}

pub(crate) struct SessionStore {
    sender: Option<mpsc::Sender<StoreMessage>>,
    worker: Option<JoinHandle<()>>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl SessionStore {
    pub fn open(path: PathBuf, fallback_path: PathBuf) -> (Self, SessionState, Option<String>) {
        let (state, warning, save_initial) = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<SessionSnapshot>(&bytes)
                .map_err(|error| error.to_string())
                .and_then(SessionState::from_snapshot)
            {
                Ok(state) => (state, None, false),
                Err(error) => (
                    SessionState::new(fallback_path),
                    Some(format!(
                        "Session recovery unavailable; the existing file was preserved: {error}"
                    )),
                    false,
                ),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                (SessionState::new(fallback_path), None, true)
            }
            Err(error) => (
                SessionState::new(fallback_path),
                Some(format!("Session recovery unavailable: {error}")),
                false,
            ),
        };

        let (sender, receiver) = mpsc::channel();
        let last_error = Arc::new(Mutex::new(None));
        let worker_error = Arc::clone(&last_error);
        let worker = thread::spawn(move || {
            while let Ok(message) = receiver.recv() {
                match message {
                    StoreMessage::Save(bytes) => {
                        let result = atomic_write(&path, &bytes).map_err(|error| error.to_string());
                        *worker_error
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner) = result.err();
                    }
                    StoreMessage::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        let store = Self {
            sender: Some(sender),
            worker: Some(worker),
            last_error,
        };
        if save_initial {
            let _ = store.save(&state);
        }
        (store, state, warning)
    }

    pub fn save(&self, state: &SessionState) -> Result<(), String> {
        let bytes =
            serde_json::to_vec_pretty(&state.snapshot()).map_err(|error| error.to_string())?;
        self.sender
            .as_ref()
            .ok_or_else(|| "session writer is unavailable".to_string())?
            .send(StoreMessage::Save(bytes))
            .map_err(|_| "session writer stopped unexpectedly".to_string())
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn flush(&self) {
        let (sender, receiver) = mpsc::sync_channel(0);
        if self
            .sender
            .as_ref()
            .is_some_and(|queue| queue.send(StoreMessage::Flush(sender)).is_ok())
        {
            let _ = receiver.recv();
        }
    }
}

impl Drop for SessionStore {
    fn drop(&mut self) {
        self.flush();
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "session path has no parent"))?;
    fs::create_dir_all(parent)?;
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .unwrap_or(path.as_os_str())
            .to_string_lossy(),
        std::process::id(),
        counter
    ));
    let result = (|| {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temp, destination)
}

#[cfg(windows)]
fn replace_file(temp: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let temp: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        MoveFileExW(
            temp.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use explorie_native_services::SearchType;
    use uuid::Uuid;

    fn fixture_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("explorie-session-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn tabs_preserve_independent_navigation_and_close_to_the_left() {
        let mut session = SessionState::new(PathBuf::from("root"));
        let first = session.active_tab_id();
        assert!(session.navigate(PathBuf::from("root/one")));
        let second = session.new_tab();
        assert_eq!(session.path(), Path::new("root/one"));
        assert!(session.navigate(PathBuf::from("root/two")));

        assert!(session.activate(first));
        assert_eq!(session.path(), Path::new("root/one"));
        assert!(session.activate(second));
        assert_eq!(session.path(), Path::new("root/two"));

        assert!(session.close(session.active_tab_id()));
        assert_eq!(session.active_tab_id(), first);
        assert_eq!(session.path(), Path::new("root/one"));
        assert!(!session.close(session.active_tab_id()));
    }

    #[test]
    fn tab_activation_wraps_and_reorder_preserves_identity() {
        let mut session = SessionState::new(PathBuf::from("root"));
        let first = session.active_tab_id();
        let second = session.new_tab();
        let third = session.new_tab();

        assert!(session.activate_offset(1));
        assert_eq!(session.active_tab_id(), first);
        assert!(session.reorder(first, third));
        assert_eq!(session.active_tab_id(), first);
        assert_eq!(session.tabs()[2].id(), first);
        assert!(session.move_active(-1));
        assert_eq!(session.tabs()[1].id(), first);
        assert!(session.activate(second));
    }

    #[test]
    fn favorites_are_unique_and_recents_are_most_recent_first_with_a_limit() {
        let mut session = SessionState::new(PathBuf::from("root"));
        assert!(session.toggle_favorite(PathBuf::from("root/favorite")));
        assert!(!session.toggle_favorite(PathBuf::from("root/favorite")));
        assert!(session.toggle_favorite(PathBuf::from("root/favorite")));
        assert_eq!(session.favorites()[0].name(), "favorite");
        assert!(session.toggle_favorite(PathBuf::from("root/second")));
        assert!(session.toggle_favorite(PathBuf::from("root/third")));
        assert!(session.reorder_favorite(Path::new("root/favorite"), 2));
        assert_eq!(session.favorites()[0].name(), "second");
        assert_eq!(session.favorites()[1].name(), "third");
        assert_eq!(session.favorites()[2].name(), "favorite");
        assert!(!session.reorder_favorite(Path::new("root/favorite"), 2));
        assert!(!session.reorder_favorite(Path::new("root/missing"), 0));

        for index in 0..7 {
            session.navigate(PathBuf::from(format!("root/{index}")));
            session.record_current_path();
        }
        assert_eq!(session.recents().len(), RECENT_LIMIT);
        assert_eq!(session.recents()[0], PathBuf::from("root/6"));
        assert_eq!(session.recents()[4], PathBuf::from("root/2"));

        session.navigate(PathBuf::from("root/4"));
        session.record_current_path();
        assert_eq!(session.recents()[0], PathBuf::from("root/4"));
        assert_eq!(
            session
                .recents()
                .iter()
                .filter(|path| *path == Path::new("root/4"))
                .count(),
            1
        );
    }

    #[test]
    fn versioned_session_round_trips_tabs_favorites_and_recents() {
        let root = fixture_dir();
        let path = root.join("session-v1.json");
        let (store, mut session, warning) = SessionStore::open(path.clone(), PathBuf::from("root"));
        assert!(warning.is_none());
        session.navigate(PathBuf::from("root/one"));
        session.record_current_path();
        let first = session.active_tab_id();
        let second = session.new_tab();
        session.navigate(PathBuf::from("root/two"));
        session.record_current_path();
        session.record_go_to_folder(PathBuf::from("root/recent-target"));
        session.record_go_to_folder(PathBuf::from("root/other-target"));
        session.record_go_to_folder(PathBuf::from("root/recent-target"));
        session.toggle_favorite(PathBuf::from("root/favorite"));
        session.toggle_favorite(PathBuf::from("root/second"));
        session.toggle_favorite(PathBuf::from("root/third"));
        assert!(session.reorder_favorite(Path::new("root/favorite"), 2));
        let smart = session.save_smart_folder(
            "Text files".into(),
            SearchCriteria {
                name_pattern: Some("text".into()),
                type_filter: SearchType::Files,
                search_paths: vec![PathBuf::from("root")],
                recursive: true,
                ..SearchCriteria::default()
            },
        );
        assert!(session.update_smart_folder(
            smart,
            "Source files".into(),
            SearchCriteria {
                name_pattern: Some("src".into()),
                extensions: vec!["rs".into(), "md".into()],
                type_filter: SearchType::Files,
                search_paths: vec![PathBuf::from("root")],
                recursive: true,
                ..SearchCriteria::default()
            },
        ));
        assert!(!session.update_smart_folder(
            u64::MAX,
            "Missing".into(),
            SearchCriteria::default(),
        ));
        assert!(session.activate_smart_folder(smart));
        store.save(&session).unwrap();
        store.flush();
        drop(store);

        let (store, restored, warning) = SessionStore::open(path, PathBuf::from("fallback"));
        assert!(warning.is_none());
        assert_eq!(restored.tabs().len(), 2);
        assert_eq!(restored.tabs()[0].id(), first);
        assert_eq!(restored.active_tab_id(), second);
        assert_eq!(restored.path(), Path::new("root/two"));
        assert_eq!(restored.back_history(), [PathBuf::from("root/one")]);
        assert!(restored.forward_history().is_empty());
        assert!(restored.is_favorite(Path::new("root/favorite")));
        assert_eq!(restored.favorites()[0].path(), Path::new("root/second"));
        assert_eq!(restored.favorites()[1].path(), Path::new("root/third"));
        assert_eq!(restored.favorites()[2].path(), Path::new("root/favorite"));
        assert_eq!(restored.recents()[0], PathBuf::from("root/two"));
        assert_eq!(
            restored.go_to_folder_recents(),
            [
                PathBuf::from("root/recent-target"),
                PathBuf::from("root/other-target")
            ]
        );
        assert_eq!(
            restored.active_smart_folder().unwrap().name(),
            "Source files"
        );
        assert_eq!(
            restored
                .active_smart_folder()
                .unwrap()
                .criteria()
                .extensions,
            ["rs", "md"]
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_session_is_reported_and_preserved() {
        let root = fixture_dir();
        let path = root.join("session-v1.json");
        fs::write(&path, b"{not-json").unwrap();

        let (store, session, warning) = SessionStore::open(path.clone(), PathBuf::from("fallback"));
        assert_eq!(session.path(), Path::new("fallback"));
        assert!(warning.is_some());
        store.flush();
        drop(store);
        assert_eq!(fs::read(&path).unwrap(), b"{not-json");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_without_navigation_history_fields_keeps_backward_compatibility() {
        let root = fixture_dir();
        let path = root.join("session-v1.json");
        fs::write(
            &path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "tabs": [{ "id": 1, "path": "legacy-root" }],
                "activeTabId": 1,
                "favorites": [],
                "recents": [],
                "goToFolderRecents": [],
                "smartFolders": [],
                "activeSmartFolderId": null
            }))
            .unwrap(),
        )
        .unwrap();

        let (store, session, warning) = SessionStore::open(path, PathBuf::from("fallback-root"));
        assert!(warning.is_none());
        assert_eq!(session.path(), Path::new("legacy-root"));
        assert!(session.back_history().is_empty());
        assert!(session.forward_history().is_empty());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
}
