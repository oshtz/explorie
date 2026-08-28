use std::borrow::Borrow;
use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use explorie_core::FileEntry;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use serde_json::Value;

const MAX_NAVIGATION_HISTORY: usize = 50;
const MAX_FOLDER_VIEW_STATES: usize = 512;
const MAX_STORED_SELECTION: usize = 1_000;
const MAX_COLUMN_WIDTHS: usize = 64;
const MAX_COLUMN_VIEW_WIDTHS: usize = 512;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderViewState {
    pub view_mode: ViewMode,
    pub sort_key: SortKey,
    pub sort_direction: SortDirection,
    #[serde(default)]
    pub selected: Vec<PathBuf>,
    #[serde(default)]
    pub scroll_index: usize,
    #[serde(default = "default_grid_min_width")]
    pub grid_min_width: u16,
    #[serde(default)]
    pub show_preview_panel: bool,
    #[serde(default)]
    pub column_widths: HashMap<String, u16>,
}

fn default_grid_min_width() -> u16 {
    180
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    List,
    Grid,
    Column,
}

impl ViewMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::List => "List",
            Self::Grid => "Grid",
            Self::Column => "Column",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryFilter {
    All,
    Folders,
    Files,
}

impl EntryFilter {
    pub fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Folders => "Folders",
            Self::Files => "Files",
        }
    }

    fn next(self) -> Self {
        match self {
            Self::All => Self::Folders,
            Self::Folders => Self::Files,
            Self::Files => Self::All,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SortKey {
    Name,
    Size,
    Modified,
    Custom(String),
}

impl SortKey {
    pub fn label(&self) -> &str {
        match self {
            Self::Name => "Name",
            Self::Size => "Size",
            Self::Modified => "Modified",
            Self::Custom(key) => key,
        }
    }

    pub fn custom(key: impl Into<String>) -> Result<Self, String> {
        let key = key.into();
        if key.is_empty() || key.len() > 128 || key.chars().any(char::is_control) {
            return Err("custom sort keys must contain 1 to 128 visible characters".to_string());
        }
        if matches!(key.as_str(), "name" | "size" | "modified") {
            return Err("built-in sort keys cannot be represented as custom keys".to_string());
        }
        Ok(Self::Custom(key))
    }

    fn from_storage_key(key: String) -> Result<Self, String> {
        match key.as_str() {
            "name" => Ok(Self::Name),
            "size" => Ok(Self::Size),
            "modified" => Ok(Self::Modified),
            _ => Self::custom(key),
        }
    }

    fn storage_key(&self) -> &str {
        match self {
            Self::Name => "name",
            Self::Size => "size",
            Self::Modified => "modified",
            Self::Custom(key) => key,
        }
    }
}

impl Serialize for SortKey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.storage_key())
    }
}

impl<'de> Deserialize<'de> for SortKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::from_storage_key(String::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Ascending,
    Descending,
}

impl SortDirection {
    pub fn indicator(self) -> &'static str {
        match self {
            Self::Ascending => "↑",
            Self::Descending => "↓",
        }
    }

    fn reversed(self) -> Self {
        match self {
            Self::Ascending => Self::Descending,
            Self::Descending => Self::Ascending,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BrowserState {
    path: PathBuf,
    back: Vec<PathBuf>,
    forward: Vec<PathBuf>,
    entries: Vec<Arc<FileEntry>>,
    visible_entries: Vec<Arc<FileEntry>>,
    selected: BTreeSet<PathBuf>,
    selection_cursor: Option<PathBuf>,
    selection_anchor: Option<PathBuf>,
    show_hidden: bool,
    show_system_files: bool,
    filter: EntryFilter,
    sort_key: SortKey,
    sort_direction: SortDirection,
    view_mode: ViewMode,
    search_query: String,
    folder_view_states: HashMap<PathBuf, FolderViewState>,
    pending_selection: Vec<PathBuf>,
    scroll_index: usize,
    grid_min_width: u16,
    show_preview_panel: bool,
    column_widths: HashMap<String, u16>,
    column_view_widths: HashMap<PathBuf, u16>,
}

impl BrowserState {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            back: Vec::new(),
            forward: Vec::new(),
            entries: Vec::new(),
            visible_entries: Vec::new(),
            selected: BTreeSet::new(),
            selection_cursor: None,
            selection_anchor: None,
            show_hidden: false,
            show_system_files: false,
            filter: EntryFilter::All,
            sort_key: SortKey::Name,
            sort_direction: SortDirection::Ascending,
            view_mode: ViewMode::List,
            search_query: String::new(),
            folder_view_states: HashMap::new(),
            pending_selection: Vec::new(),
            scroll_index: 0,
            grid_min_width: default_grid_min_width(),
            show_preview_panel: false,
            column_widths: HashMap::new(),
            column_view_widths: HashMap::new(),
        }
    }

    pub(super) fn fork_for_new_tab(&self) -> Self {
        let mut browser = self.clone();
        browser.back.clear();
        browser.forward.clear();
        browser.clear_listing();
        browser.restore_current_folder_view();
        browser
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn can_go_back(&self) -> bool {
        !self.back.is_empty()
    }

    pub fn can_go_forward(&self) -> bool {
        !self.forward.is_empty()
    }

    pub fn back_history(&self) -> &[PathBuf] {
        &self.back
    }

    pub fn forward_history(&self) -> &[PathBuf] {
        &self.forward
    }

    pub fn restore_navigation_history(
        &mut self,
        mut back: Vec<PathBuf>,
        mut forward: Vec<PathBuf>,
    ) {
        keep_newest_history(&mut back);
        keep_newest_history(&mut forward);
        self.back = back;
        self.forward = forward;
    }

    pub fn can_go_up(&self) -> bool {
        self.path.parent().is_some()
    }

    pub fn visible_entries(&self) -> &[Arc<FileEntry>] {
        &self.visible_entries
    }

    pub fn entries(&self) -> &[Arc<FileEntry>] {
        &self.entries
    }

    pub fn custom_columns(&self) -> Vec<String> {
        let normalized_query = self.search_query.to_lowercase();
        collect_custom_columns(self.entries.iter().map(Arc::as_ref).filter(|entry| {
            (self.show_hidden || !entry.hidden)
                && (self.show_system_files || !is_system_file(entry))
                && match self.filter {
                    EntryFilter::All => true,
                    EntryFilter::Folders => entry.is_dir,
                    EntryFilter::Files => !entry.is_dir,
                }
                && (normalized_query.is_empty()
                    || file_name(entry).to_lowercase().contains(&normalized_query))
        }))
    }

    pub fn selected_path(&self) -> Option<&Path> {
        self.selection_cursor
            .as_deref()
            .filter(|path| self.selected.contains(*path))
            .or_else(|| self.selected.first().map(PathBuf::as_path))
    }

    pub fn selection_count(&self) -> usize {
        self.selected.len()
    }

    pub fn selected_paths(&self) -> Vec<PathBuf> {
        self.visible_entries
            .iter()
            .filter(|entry| self.selected.contains(&entry.path))
            .map(|entry| entry.path.clone())
            .collect()
    }

    pub fn selected_entries(&self) -> Vec<FileEntry> {
        self.visible_entries
            .iter()
            .filter(|entry| self.selected.contains(&entry.path))
            .map(|entry| entry.as_ref().clone())
            .collect()
    }

    pub fn is_selected(&self, path: &Path) -> bool {
        self.selected.contains(path)
    }

    pub fn selected_entry(&self) -> Option<&FileEntry> {
        let selected = self.selected_path()?;
        self.visible_entries
            .iter()
            .find(|entry| entry.path == selected)
            .map(Arc::as_ref)
    }

    pub fn show_hidden(&self) -> bool {
        self.show_hidden
    }

    pub fn show_system_files(&self) -> bool {
        self.show_system_files
    }

    pub fn filter(&self) -> EntryFilter {
        self.filter
    }

    pub fn sort_key(&self) -> SortKey {
        self.sort_key.clone()
    }

    pub fn sort_direction(&self) -> SortDirection {
        self.sort_direction
    }

    pub fn view_mode(&self) -> ViewMode {
        self.view_mode
    }

    pub fn set_view_mode(&mut self, view_mode: ViewMode) {
        self.view_mode = view_mode;
    }

    pub fn apply_common_preferences(
        &mut self,
        show_hidden: bool,
        show_system_files: bool,
        filter: EntryFilter,
    ) {
        self.show_hidden = show_hidden;
        self.show_system_files = show_system_files;
        self.filter = filter;
        self.rebuild_visible_entries();
    }

    pub fn folder_view_states(&self) -> &HashMap<PathBuf, FolderViewState> {
        &self.folder_view_states
    }

    pub fn has_current_folder_view_state(&self) -> bool {
        self.folder_view_states.contains_key(&self.path)
    }

    pub fn restore_folder_view_states(&mut self, states: HashMap<PathBuf, FolderViewState>) {
        self.folder_view_states = states
            .into_iter()
            .take(MAX_FOLDER_VIEW_STATES)
            .map(|(path, mut state)| {
                state.selected.truncate(MAX_STORED_SELECTION);
                if state.column_widths.len() > MAX_COLUMN_WIDTHS {
                    state.column_widths = state
                        .column_widths
                        .into_iter()
                        .take(MAX_COLUMN_WIDTHS)
                        .collect();
                }
                (path, state)
            })
            .collect();
        self.restore_current_folder_view();
    }

    pub fn sync_folder_ui_state(
        &mut self,
        scroll_index: usize,
        grid_min_width: u16,
        show_preview_panel: bool,
    ) {
        self.scroll_index = scroll_index;
        self.grid_min_width = grid_min_width;
        self.show_preview_panel = show_preview_panel;
        self.capture_current_folder_view();
    }

    pub fn folder_ui_state(&self) -> (usize, u16, bool) {
        (
            self.scroll_index,
            self.grid_min_width,
            self.show_preview_panel,
        )
    }

    pub fn column_width(&self, key: &str) -> Option<u16> {
        self.column_widths.get(key).copied()
    }

    pub fn set_column_width(&mut self, key: String, width: u16) {
        self.column_widths.insert(key, width);
    }

    pub fn column_view_widths(&self) -> &HashMap<PathBuf, u16> {
        &self.column_view_widths
    }

    pub fn restore_column_view_widths(&mut self, widths: HashMap<PathBuf, u16>) {
        self.column_view_widths = widths.into_iter().take(MAX_COLUMN_VIEW_WIDTHS).collect();
    }

    pub fn column_view_width(&self, path: &Path) -> Option<u16> {
        self.column_view_widths.get(path).copied()
    }

    pub fn set_column_view_width(&mut self, path: PathBuf, width: u16) {
        if !self.column_view_widths.contains_key(&path)
            && self.column_view_widths.len() >= MAX_COLUMN_VIEW_WIDTHS
            && let Some(stale) = self.column_view_widths.keys().next().cloned()
        {
            self.column_view_widths.remove(&stale);
        }
        self.column_view_widths.insert(path, width);
    }

    pub fn apply_preferences(
        &mut self,
        show_hidden: bool,
        show_system_files: bool,
        filter: EntryFilter,
        sort_key: SortKey,
        sort_direction: SortDirection,
        view_mode: ViewMode,
    ) {
        self.show_hidden = show_hidden;
        self.show_system_files = show_system_files;
        self.filter = filter;
        self.sort_key = sort_key;
        self.sort_direction = sort_direction;
        self.view_mode = view_mode;
        self.rebuild_visible_entries();
    }

    pub fn search_query(&self) -> &str {
        &self.search_query
    }

    pub fn push_search_text(&mut self, text: &str) {
        self.search_query.push_str(text);
        self.rebuild_visible_entries();
    }

    pub fn set_search_query(&mut self, query: String) {
        self.search_query = query;
        self.rebuild_visible_entries();
    }

    pub fn pop_search_character(&mut self) {
        self.search_query.pop();
        self.rebuild_visible_entries();
    }

    pub fn clear_search(&mut self) {
        self.search_query.clear();
        self.rebuild_visible_entries();
    }

    pub fn navigate(&mut self, path: PathBuf) -> bool {
        if path == self.path {
            return false;
        }
        self.capture_current_folder_view();
        self.back.push(std::mem::replace(&mut self.path, path));
        keep_newest_history(&mut self.back);
        self.forward.clear();
        self.clear_listing();
        self.restore_current_folder_view();
        true
    }

    pub fn go_back(&mut self) -> bool {
        let Some(path) = self.back.pop() else {
            return false;
        };
        self.capture_current_folder_view();
        self.forward.push(std::mem::replace(&mut self.path, path));
        keep_newest_history(&mut self.forward);
        self.clear_listing();
        self.restore_current_folder_view();
        true
    }

    pub fn go_forward(&mut self) -> bool {
        let Some(path) = self.forward.pop() else {
            return false;
        };
        self.capture_current_folder_view();
        self.back.push(std::mem::replace(&mut self.path, path));
        keep_newest_history(&mut self.back);
        self.clear_listing();
        self.restore_current_folder_view();
        true
    }

    pub fn go_to_back_history(&mut self, index: usize) -> bool {
        let Some(actual_index) = self.back.len().checked_sub(index + 1) else {
            return false;
        };
        self.capture_current_folder_view();
        let mut skipped = self.back.split_off(actual_index);
        let target = skipped.remove(0);
        self.forward.push(std::mem::replace(&mut self.path, target));
        self.forward.extend(skipped.into_iter().rev());
        keep_newest_history(&mut self.forward);
        self.clear_listing();
        self.restore_current_folder_view();
        true
    }

    pub fn go_to_forward_history(&mut self, index: usize) -> bool {
        let Some(actual_index) = self.forward.len().checked_sub(index + 1) else {
            return false;
        };
        self.capture_current_folder_view();
        let target = self.forward.remove(actual_index);
        let skipped = self.forward.split_off(actual_index);
        self.back.push(std::mem::replace(&mut self.path, target));
        self.back.extend(skipped.into_iter().rev());
        keep_newest_history(&mut self.back);
        self.clear_listing();
        self.restore_current_folder_view();
        true
    }

    pub fn clear_navigation_history(&mut self) {
        self.back.clear();
        self.forward.clear();
    }

    pub fn go_up(&mut self) -> bool {
        let Some(parent) = self.path.parent().map(Path::to_path_buf) else {
            return false;
        };
        self.navigate(parent)
    }

    pub fn replace_entries(&mut self, entries: Vec<FileEntry>) {
        self.entries = entries.into_iter().map(Arc::new).collect();
        self.rebuild_visible_entries();
        if !self.pending_selection.is_empty() {
            let selection = std::mem::take(&mut self.pending_selection);
            self.replace_selection(selection);
        }
    }

    /// Append a progressive result batch without re-sorting every result seen
    /// so far. The authoritative completion replaces and sorts the full set.
    pub fn append_progressive_entries(&mut self, entries: Vec<FileEntry>) {
        if entries.is_empty() {
            return;
        }
        let normalized_query = self.search_query.to_lowercase();
        self.entries.reserve(entries.len());
        self.visible_entries.reserve(entries.len());
        for entry in entries {
            let entry = Arc::new(entry);
            if entry_is_visible(
                entry.as_ref(),
                self.show_hidden,
                self.show_system_files,
                self.filter,
                &normalized_query,
            ) {
                self.visible_entries.push(Arc::clone(&entry));
            }
            self.entries.push(entry);
        }
    }

    pub fn toggle_hidden(&mut self) {
        self.show_hidden = !self.show_hidden;
        self.rebuild_visible_entries();
    }

    pub fn toggle_system_files(&mut self) {
        self.show_system_files = !self.show_system_files;
        self.rebuild_visible_entries();
    }

    pub fn cycle_filter(&mut self) {
        self.filter = self.filter.next();
        self.rebuild_visible_entries();
    }

    pub fn set_filter(&mut self, filter: EntryFilter) {
        self.filter = filter;
        self.rebuild_visible_entries();
    }

    pub fn set_sort(&mut self, key: SortKey) {
        if self.sort_key == key {
            self.sort_direction = self.sort_direction.reversed();
        } else {
            self.sort_key = key;
            self.sort_direction = SortDirection::Ascending;
        }
        self.rebuild_visible_entries();
    }

    #[cfg(test)]
    pub fn cycle_sort_key(&mut self) {
        self.sort_key = match self.sort_key {
            SortKey::Name => SortKey::Size,
            SortKey::Size => SortKey::Modified,
            SortKey::Modified | SortKey::Custom(_) => SortKey::Name,
        };
        self.sort_direction = SortDirection::Ascending;
        self.rebuild_visible_entries();
    }

    pub fn select(&mut self, path: PathBuf) {
        if self.visible_entries.iter().any(|entry| entry.path == path) {
            self.selected.clear();
            self.selected.insert(path.clone());
            self.selection_cursor = Some(path.clone());
            self.selection_anchor = Some(path);
        }
    }

    pub fn toggle_selection(&mut self, path: PathBuf) {
        if !self.visible_entries.iter().any(|entry| entry.path == path) {
            return;
        }
        if !self.selected.remove(&path) {
            self.selected.insert(path.clone());
        }
        self.selection_cursor = self.selected.contains(&path).then(|| path.clone());
        if self.selection_cursor.is_none() {
            self.selection_cursor = self.selected.first().cloned();
        }
        self.selection_anchor = Some(path);
    }

    pub fn select_range_to(&mut self, path: PathBuf) {
        let Some(target) = self
            .visible_entries
            .iter()
            .position(|entry| entry.path == path)
        else {
            return;
        };
        let anchor_path = self
            .selection_anchor
            .as_ref()
            .or(self.selection_cursor.as_ref())
            .unwrap_or(&path);
        let anchor = self
            .visible_entries
            .iter()
            .position(|entry| &entry.path == anchor_path)
            .unwrap_or(target);
        let (start, end) = if anchor <= target {
            (anchor, target)
        } else {
            (target, anchor)
        };
        self.selected = self.visible_entries[start..=end]
            .iter()
            .map(|entry| entry.path.clone())
            .collect();
        self.selection_cursor = Some(path);
        if self.selection_anchor.is_none() {
            self.selection_anchor = self
                .visible_entries
                .get(anchor)
                .map(|entry| entry.path.clone());
        }
    }

    pub fn select_all(&mut self) {
        self.selected = self
            .visible_entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect();
        self.selection_cursor = self.visible_entries.first().map(|entry| entry.path.clone());
        self.selection_anchor = self.selection_cursor.clone();
    }

    pub fn replace_selection<I>(&mut self, paths: I)
    where
        I: IntoIterator<Item = PathBuf>,
    {
        let requested: BTreeSet<_> = paths.into_iter().collect();
        self.selected = self
            .visible_entries
            .iter()
            .filter(|entry| requested.contains(&entry.path))
            .map(|entry| entry.path.clone())
            .collect();
        self.selection_cursor = self.selected.first().cloned();
        self.selection_anchor = self.selection_cursor.clone();
    }

    pub fn select_prefix(&mut self, prefix: &str) -> Option<usize> {
        let prefix = prefix.to_lowercase();
        let index = self
            .visible_entries
            .iter()
            .position(|entry| file_name(entry).to_lowercase().starts_with(&prefix))?;
        self.select(self.visible_entries[index].path.clone());
        Some(index)
    }

    pub fn clear_selection(&mut self) {
        self.selected.clear();
        self.selection_cursor = None;
        self.selection_anchor = None;
    }

    pub fn select_next(&mut self) -> Option<usize> {
        self.select_offset(1)
    }

    pub fn select_previous(&mut self) -> Option<usize> {
        self.select_offset(-1)
    }

    pub fn select_offset(&mut self, offset: isize) -> Option<usize> {
        if self.visible_entries.is_empty() {
            self.clear_selection();
            return None;
        }
        let next = self
            .selected_path()
            .and_then(|selected| {
                self.visible_entries
                    .iter()
                    .position(|entry| entry.path == selected)
            })
            .map_or(0, |index| {
                index
                    .saturating_add_signed(offset)
                    .min(self.visible_entries.len() - 1)
            });
        self.select(self.visible_entries[next].path.clone());
        Some(next)
    }

    pub fn select_next_range(&mut self) -> Option<usize> {
        self.select_range_offset(1)
    }

    pub fn select_previous_range(&mut self) -> Option<usize> {
        self.select_range_offset(-1)
    }

    pub fn select_range_offset(&mut self, offset: isize) -> Option<usize> {
        if self.visible_entries.is_empty() {
            self.clear_selection();
            return None;
        }
        let current = self
            .selected_path()
            .and_then(|selected| {
                self.visible_entries
                    .iter()
                    .position(|entry| entry.path == selected)
            })
            .unwrap_or_else(|| {
                if offset > 0 {
                    0
                } else {
                    self.visible_entries.len() - 1
                }
            });
        if self.selection_anchor.is_none() {
            self.selection_anchor = self
                .visible_entries
                .get(current)
                .map(|entry| entry.path.clone());
        }
        let next = current
            .saturating_add_signed(offset)
            .min(self.visible_entries.len() - 1);
        self.select_range_to(self.visible_entries[next].path.clone());
        Some(next)
    }

    fn clear_listing(&mut self) {
        self.entries.clear();
        self.visible_entries.clear();
        self.clear_selection();
    }

    fn capture_current_folder_view(&mut self) {
        if !self.folder_view_states.contains_key(&self.path)
            && self.folder_view_states.len() >= MAX_FOLDER_VIEW_STATES
            && let Some(stale) = self
                .folder_view_states
                .keys()
                .find(|path| path.as_path() != self.path)
                .cloned()
        {
            self.folder_view_states.remove(&stale);
        }
        let mut selected = if self.entries.is_empty() && !self.pending_selection.is_empty() {
            self.pending_selection.clone()
        } else {
            self.selected.iter().cloned().collect()
        };
        selected.truncate(MAX_STORED_SELECTION);
        let column_widths = self
            .column_widths
            .iter()
            .take(MAX_COLUMN_WIDTHS)
            .map(|(key, width)| (key.clone(), *width))
            .collect();
        self.folder_view_states.insert(
            self.path.clone(),
            FolderViewState {
                view_mode: self.view_mode,
                sort_key: self.sort_key.clone(),
                sort_direction: self.sort_direction,
                selected,
                scroll_index: self.scroll_index,
                grid_min_width: self.grid_min_width,
                show_preview_panel: self.show_preview_panel,
                column_widths,
            },
        );
    }

    fn restore_current_folder_view(&mut self) {
        let Some(state) = self.folder_view_states.get(&self.path).cloned() else {
            self.pending_selection.clear();
            self.scroll_index = 0;
            return;
        };
        self.view_mode = state.view_mode;
        self.sort_key = state.sort_key;
        self.sort_direction = state.sort_direction;
        self.pending_selection = state.selected;
        self.scroll_index = state.scroll_index;
        self.grid_min_width = state.grid_min_width;
        self.show_preview_panel = state.show_preview_panel;
        self.column_widths = state.column_widths;
    }

    fn rebuild_visible_entries(&mut self) {
        self.visible_entries = filtered_sorted_entry_refs(
            &self.entries,
            self.show_hidden,
            self.show_system_files,
            self.filter,
            &self.sort_key,
            self.sort_direction,
            &self.search_query,
        );

        self.selected.retain(|selected| {
            self.visible_entries
                .iter()
                .any(|entry| &entry.path == selected)
        });
        if self
            .selection_cursor
            .as_ref()
            .is_some_and(|path| !self.selected.contains(path))
        {
            self.selection_cursor = self.selected.first().cloned();
        }
        if self
            .selection_anchor
            .as_ref()
            .is_some_and(|path| !self.selected.contains(path))
        {
            self.selection_anchor = self.selection_cursor.clone();
        }
    }
}

fn filtered_sorted_entry_refs(
    entries: &[Arc<FileEntry>],
    show_hidden: bool,
    show_system_files: bool,
    filter: EntryFilter,
    sort_key: &SortKey,
    sort_direction: SortDirection,
    search_query: &str,
) -> Vec<Arc<FileEntry>> {
    let normalized_query = search_query.to_lowercase();
    let mut visible = entries
        .iter()
        .filter(|entry| {
            entry_is_visible(
                entry.as_ref(),
                show_hidden,
                show_system_files,
                filter,
                &normalized_query,
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    sort_entries(&mut visible, sort_key, sort_direction);
    visible
}

fn keep_newest_history(history: &mut Vec<PathBuf>) {
    if history.len() > MAX_NAVIGATION_HISTORY {
        history.drain(..history.len() - MAX_NAVIGATION_HISTORY);
    }
}

pub fn filtered_sorted_entries(
    entries: &[FileEntry],
    show_hidden: bool,
    show_system_files: bool,
    filter: EntryFilter,
    sort_key: &SortKey,
    sort_direction: SortDirection,
    search_query: &str,
) -> Vec<FileEntry> {
    let normalized_query = search_query.to_lowercase();
    let mut visible: Vec<_> = entries
        .iter()
        .filter(|entry| {
            entry_is_visible(
                entry,
                show_hidden,
                show_system_files,
                filter,
                &normalized_query,
            )
        })
        .cloned()
        .collect();

    sort_entries(&mut visible, sort_key, sort_direction);
    visible
}

fn sort_entries<T: Borrow<FileEntry>>(
    entries: &mut [T],
    sort_key: &SortKey,
    sort_direction: SortDirection,
) {
    if *sort_key == SortKey::Name {
        entries.sort_by_cached_key(|entry| file_name(entry.borrow()).to_lowercase());
        if sort_direction == SortDirection::Descending {
            entries.reverse();
        }
        // This stable partition keeps folders first without recomputing names.
        entries.sort_by_key(|entry| !entry.borrow().is_dir);
        return;
    }
    entries.sort_by(|left, right| {
        compare_entries(left.borrow(), right.borrow(), sort_key, sort_direction)
    });
}

fn compare_entries(
    left: &FileEntry,
    right: &FileEntry,
    sort_key: &SortKey,
    sort_direction: SortDirection,
) -> Ordering {
    let directory_order = right.is_dir.cmp(&left.is_dir);
    if directory_order != Ordering::Equal {
        return directory_order;
    }

    let order = match sort_key {
        SortKey::Name => file_name(left).cmp(&file_name(right)),
        SortKey::Size => left.size.cmp(&right.size),
        SortKey::Modified => left.modified.cmp(&right.modified),
        SortKey::Custom(key) => compare_custom_fields(left, right, key),
    };
    let order = match sort_direction {
        SortDirection::Ascending => order,
        SortDirection::Descending => order.reverse(),
    };
    order.then_with(|| file_name(left).cmp(&file_name(right)))
}

fn entry_is_visible(
    entry: &FileEntry,
    show_hidden: bool,
    show_system_files: bool,
    filter: EntryFilter,
    normalized_query: &str,
) -> bool {
    (show_hidden || !entry.hidden)
        && (show_system_files || !is_system_file(entry))
        && match filter {
            EntryFilter::All => true,
            EntryFilter::Folders => entry.is_dir,
            EntryFilter::Files => !entry.is_dir,
        }
        && (normalized_query.is_empty()
            || file_name(entry).to_lowercase().contains(normalized_query))
}

const CUSTOM_COLUMN_SCAN_LIMIT: usize = 500;
const CUSTOM_COLUMN_CANDIDATES: [&str; 4] = ["status", "type", "category", "priority"];

#[cfg(test)]
pub fn custom_columns(entries: &[FileEntry]) -> Vec<String> {
    collect_custom_columns(entries.iter())
}

fn collect_custom_columns<'a>(entries: impl Iterator<Item = &'a FileEntry>) -> Vec<String> {
    entries
        .take(CUSTOM_COLUMN_SCAN_LIMIT)
        .flat_map(|entry| entry.custom.iter())
        .filter(|(key, value)| is_custom_column_candidate(key, value))
        .map(|(key, _)| key.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn is_custom_column_candidate(key: &str, value: &Value) -> bool {
    if !CUSTOM_COLUMN_CANDIDATES
        .iter()
        .any(|candidate| key.eq_ignore_ascii_case(candidate))
    {
        return false;
    }
    match value {
        Value::Bool(_) | Value::Number(_) => true,
        Value::String(value) => value.chars().count() <= 50,
        Value::Null | Value::Array(_) | Value::Object(_) => false,
    }
}

fn compare_custom_fields(left: &FileEntry, right: &FileEntry, key: &str) -> Ordering {
    match (left.custom.get(key), right.custom.get(key)) {
        (Some(Value::String(left)), Some(Value::String(right))) => left.cmp(right),
        (Some(Value::Number(left)), Some(Value::Number(right))) => left
            .as_f64()
            .partial_cmp(&right.as_f64())
            .unwrap_or(Ordering::Equal),
        (Some(Value::Bool(left)), Some(Value::Bool(right))) => left.cmp(right),
        (Some(Value::Null), Some(Value::Null)) => Ordering::Equal,
        (Some(Value::Null), Some(_)) => Ordering::Less,
        (Some(_), Some(Value::Null)) => Ordering::Greater,
        (Some(_), Some(_)) => Ordering::Equal,
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn is_system_file(entry: &FileEntry) -> bool {
    let name = file_name(entry);
    let lowercase = name.to_ascii_lowercase();
    lowercase.starts_with("._")
        || matches!(
            lowercase.as_str(),
            ".ds_store"
                | ".spotlight-v100"
                | ".trashes"
                | ".fseventsd"
                | ".temporaryitems"
                | ".documentrevisions-v100"
                | ".volumeicon.icns"
                | "desktop.ini"
                | "thumbs.db"
                | "$recycle.bin"
                | "system volume information"
                | ".git"
                | ".svn"
                | ".hg"
        )
}

pub fn file_name(entry: &FileEntry) -> String {
    entry
        .path
        .file_name()
        .unwrap_or_else(|| entry.path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::{Duration, UNIX_EPOCH};

    use uuid::Uuid;

    use super::*;

    fn entry(name: &str, is_dir: bool, size: u64, hidden: bool, modified: u64) -> FileEntry {
        FileEntry {
            id: Uuid::new_v4(),
            path: PathBuf::from("root").join(name),
            size,
            modified: UNIX_EPOCH + Duration::from_secs(modified),
            hidden,
            is_dir,
            custom: HashMap::new(),
            is_symlink: false,
            is_junction: false,
            link_target: None,
            has_xattrs: false,
        }
    }

    #[test]
    fn navigation_tracks_back_forward_and_discards_forward_branches() {
        let mut state = BrowserState::new(PathBuf::from("one"));
        assert!(state.navigate(PathBuf::from("two")));
        assert!(state.navigate(PathBuf::from("three")));
        assert!(state.go_back());
        assert_eq!(state.path(), Path::new("two"));
        assert!(state.can_go_forward());

        assert!(state.navigate(PathBuf::from("branch")));
        assert_eq!(state.path(), Path::new("branch"));
        assert!(!state.can_go_forward());
    }

    #[test]
    fn navigation_history_jumps_caps_and_clears_like_the_retained_browser() {
        let mut state = BrowserState::new(PathBuf::from("root/0"));
        for index in 1..=55 {
            assert!(state.navigate(PathBuf::from(format!("root/{index}"))));
        }
        assert_eq!(state.back_history().len(), MAX_NAVIGATION_HISTORY);
        assert_eq!(state.back_history()[0], PathBuf::from("root/5"));
        assert_eq!(state.back_history()[49], PathBuf::from("root/54"));

        assert!(state.go_to_back_history(2));
        assert_eq!(state.path(), Path::new("root/52"));
        assert_eq!(
            state
                .forward_history()
                .iter()
                .rev()
                .cloned()
                .collect::<Vec<_>>(),
            [
                PathBuf::from("root/53"),
                PathBuf::from("root/54"),
                PathBuf::from("root/55")
            ]
        );
        assert!(state.go_to_forward_history(2));
        assert_eq!(state.path(), Path::new("root/55"));
        assert!(!state.can_go_forward());

        state.clear_navigation_history();
        assert!(!state.can_go_back());
        assert!(!state.can_go_forward());
        assert!(!state.go_to_back_history(0));
        assert!(!state.go_to_forward_history(0));
    }

    #[test]
    fn folders_stay_first_while_sort_direction_changes() {
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(vec![
            entry("small.txt", false, 1, false, 10),
            entry("folder", true, 0, false, 5),
            entry("large.txt", false, 100, false, 20),
        ]);
        state.set_sort(SortKey::Size);
        assert_eq!(file_name(&state.visible_entries()[0]), "folder");
        assert_eq!(file_name(&state.visible_entries()[1]), "small.txt");

        state.set_sort(SortKey::Size);
        assert_eq!(file_name(&state.visible_entries()[0]), "folder");
        assert_eq!(file_name(&state.visible_entries()[1]), "large.txt");
    }

    #[test]
    fn custom_columns_match_the_bounded_legacy_candidate_contract() {
        let mut entries = vec![entry("first.txt", false, 1, false, 0)];
        entries[0]
            .custom
            .insert("status".to_string(), Value::from("Done"));
        entries[0]
            .custom
            .insert("priority".to_string(), Value::from(3));
        entries[0]
            .custom
            .insert("tags".to_string(), serde_json::json!(["work"]));
        entries[0]
            .custom
            .insert("notes".to_string(), Value::from("short but not a column"));
        entries[0]
            .custom
            .insert("category".to_string(), Value::from("x".repeat(51)));
        for index in 1..=500 {
            entries.push(entry(&format!("file-{index}.txt"), false, index, false, 0));
        }
        entries[500]
            .custom
            .insert("type".to_string(), Value::from("Document"));

        assert_eq!(
            custom_columns(&entries),
            vec!["priority".to_string(), "status".to_string()]
        );
    }

    #[test]
    fn custom_sort_preserves_present_missing_numeric_and_direction_behavior() {
        let mut low = entry("low.txt", false, 1, false, 0);
        low.custom.insert("priority".to_string(), Value::from(1));
        let mut high = entry("high.txt", false, 1, false, 0);
        high.custom.insert("priority".to_string(), Value::from(10));
        let missing = entry("missing.txt", false, 1, false, 0);
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(vec![missing, high, low]);

        state.set_sort(SortKey::custom("priority").unwrap());
        assert_eq!(
            state
                .visible_entries()
                .iter()
                .map(|entry| file_name(entry))
                .collect::<Vec<_>>(),
            ["low.txt", "high.txt", "missing.txt"]
        );
        state.set_sort(SortKey::custom("priority").unwrap());
        assert_eq!(
            state
                .visible_entries()
                .iter()
                .map(|entry| file_name(entry))
                .collect::<Vec<_>>(),
            ["missing.txt", "high.txt", "low.txt"]
        );
    }

    #[test]
    fn custom_columns_do_not_disappear_when_sorting_moves_missing_rows_first() {
        let mut tagged = entry("tagged.txt", false, 1, false, 0);
        tagged
            .custom
            .insert("status".to_string(), Value::from("Done"));
        let mut entries = vec![tagged];
        entries
            .extend((0..500).map(|index| entry(&format!("plain-{index}.txt"), false, 1, false, 0)));
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(entries);
        state.set_sort(SortKey::custom("status").unwrap());
        state.set_sort(SortKey::custom("status").unwrap());

        assert_eq!(file_name(&state.visible_entries()[0]), "plain-0.txt");
        assert_eq!(state.custom_columns(), vec!["status".to_string()]);
    }

    #[test]
    fn sort_keys_round_trip_as_legacy_compatible_strings() {
        assert_eq!(serde_json::to_string(&SortKey::Name).unwrap(), "\"name\"");
        let custom = SortKey::custom("status").unwrap();
        assert_eq!(serde_json::to_string(&custom).unwrap(), "\"status\"");
        assert_eq!(
            serde_json::from_str::<SortKey>("\"status\"").unwrap(),
            custom
        );
        assert!(serde_json::from_str::<SortKey>("\"\"").is_err());
    }

    #[test]
    fn sort_key_cycle_is_available_outside_the_list_header() {
        let mut state = BrowserState::new(PathBuf::from("root"));
        assert_eq!(state.sort_key(), SortKey::Name);
        state.cycle_sort_key();
        assert_eq!(state.sort_key(), SortKey::Size);
        state.cycle_sort_key();
        assert_eq!(state.sort_key(), SortKey::Modified);
        state.cycle_sort_key();
        assert_eq!(state.sort_key(), SortKey::Name);
    }

    #[test]
    fn hidden_and_type_filters_reconcile_selection() {
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(vec![
            entry("folder", true, 0, false, 0),
            entry("visible.txt", false, 1, false, 0),
            entry(".secret", false, 2, true, 0),
        ]);
        assert_eq!(state.visible_entries().len(), 2);

        state.toggle_hidden();
        assert_eq!(state.visible_entries().len(), 3);
        state.select(PathBuf::from("root/.secret"));
        state.cycle_filter();
        assert_eq!(state.filter(), EntryFilter::Folders);
        assert!(state.selected_path().is_none());
        assert_eq!(state.visible_entries().len(), 1);
    }

    #[test]
    fn system_files_are_hidden_independently_from_dotfiles() {
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(vec![
            entry("visible.txt", false, 1, false, 0),
            entry(".notes", false, 1, true, 0),
            entry(".DS_Store", false, 1, false, 0),
            entry("desktop.ini", false, 1, false, 0),
            entry(".git", true, 0, true, 0),
        ]);

        assert_eq!(state.visible_entries().len(), 1);
        state.toggle_hidden();
        assert_eq!(state.visible_entries().len(), 2);
        assert!(
            state
                .visible_entries()
                .iter()
                .any(|entry| file_name(entry) == ".notes")
        );

        state.toggle_system_files();
        assert_eq!(state.visible_entries().len(), 5);
    }

    #[test]
    fn name_search_is_case_insensitive_and_reconciles_selection() {
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(vec![
            entry("Alpha.txt", false, 0, false, 0),
            entry("beta.txt", false, 0, false, 0),
        ]);
        state.select(PathBuf::from("root/beta.txt"));

        state.push_search_text("ALP");
        assert_eq!(state.visible_entries().len(), 1);
        assert_eq!(file_name(&state.visible_entries()[0]), "Alpha.txt");
        assert!(state.selected_path().is_none());

        state.pop_search_character();
        state.clear_search();
        assert_eq!(state.visible_entries().len(), 2);
    }

    #[test]
    fn keyboard_selection_clamps_at_both_ends() {
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(vec![
            entry("a", false, 0, false, 0),
            entry("b", false, 0, false, 0),
        ]);

        assert_eq!(state.select_previous(), Some(0));
        assert_eq!(state.select_previous(), Some(0));
        assert_eq!(state.select_next(), Some(1));
        assert_eq!(state.select_next(), Some(1));
    }

    #[test]
    fn keyboard_selection_supports_grid_sized_offsets_and_ranges() {
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(
            (0..10)
                .map(|index| entry(&format!("{index:02}"), false, 0, false, 0))
                .collect(),
        );

        assert_eq!(state.select_offset(4), Some(0));
        assert_eq!(state.select_offset(4), Some(4));
        assert_eq!(state.select_range_offset(4), Some(8));
        assert_eq!(state.selection_count(), 5);
        assert_eq!(state.select_offset(-4), Some(4));
        assert_eq!(state.select_offset(-8), Some(0));
        assert_eq!(state.select_offset(20), Some(9));
    }

    #[test]
    fn view_mode_changes_without_losing_selection_or_filters() {
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(vec![entry("a", false, 0, false, 0)]);
        state.cycle_filter();
        state.cycle_filter();
        state.select(PathBuf::from("root/a"));

        state.set_view_mode(ViewMode::Grid);

        assert_eq!(state.view_mode(), ViewMode::Grid);
        assert_eq!(state.filter(), EntryFilter::Files);
        assert_eq!(state.selected_path(), Some(Path::new("root/a")));
    }

    #[test]
    fn refresh_keeps_selection_when_the_entry_still_exists() {
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(vec![entry("a", false, 1, false, 1)]);
        state.select(PathBuf::from("root/a"));

        state.replace_entries(vec![
            entry("a", false, 2, false, 2),
            entry("b", false, 1, false, 1),
        ]);

        assert_eq!(state.selected_path(), Some(Path::new("root/a")));
        assert_eq!(state.selected_entry().unwrap().size, 2);
    }

    #[test]
    fn selection_supports_replace_toggle_range_and_select_all() {
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(vec![
            entry("a", false, 0, false, 0),
            entry("b", false, 0, false, 0),
            entry("c", false, 0, false, 0),
            entry("d", false, 0, false, 0),
        ]);

        state.select(PathBuf::from("root/a"));
        state.toggle_selection(PathBuf::from("root/c"));
        assert_eq!(state.selection_count(), 2);
        assert!(state.is_selected(Path::new("root/a")));
        assert!(state.is_selected(Path::new("root/c")));

        state.select_range_to(PathBuf::from("root/d"));
        assert_eq!(state.selection_count(), 2);
        assert!(state.is_selected(Path::new("root/c")));
        assert!(state.is_selected(Path::new("root/d")));

        state.select_all();
        assert_eq!(state.selection_count(), 4);
        state.replace_selection([
            PathBuf::from("root/b"),
            PathBuf::from("root/d"),
            PathBuf::from("root/missing"),
        ]);
        assert_eq!(state.selection_count(), 2);
        assert!(state.is_selected(Path::new("root/b")));
        assert!(state.is_selected(Path::new("root/d")));
        assert_eq!(state.selected_path(), Some(Path::new("root/b")));
        state.clear_selection();
        assert_eq!(state.selection_count(), 0);
    }

    #[test]
    fn range_keyboard_selection_keeps_anchor_and_refresh_reconciles_each_path() {
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(vec![
            entry("a", false, 0, false, 0),
            entry("b", false, 0, false, 0),
            entry("c", false, 0, false, 0),
        ]);
        state.select(PathBuf::from("root/a"));

        assert_eq!(state.select_next_range(), Some(1));
        assert_eq!(state.select_next_range(), Some(2));
        assert_eq!(state.selection_count(), 3);
        assert_eq!(state.select_previous_range(), Some(1));
        assert_eq!(state.selection_count(), 2);

        state.replace_entries(vec![
            entry("b", false, 1, false, 1),
            entry("c", false, 1, false, 1),
        ]);
        assert_eq!(state.selection_count(), 1);
        assert!(state.is_selected(Path::new("root/b")));
    }

    #[test]
    fn type_to_select_matches_a_case_insensitive_prefix() {
        let mut state = BrowserState::new(PathBuf::from("root"));
        state.replace_entries(vec![
            entry("Alpha.txt", false, 0, false, 0),
            entry("beta.txt", false, 0, false, 0),
        ]);

        assert_eq!(state.select_prefix("BE"), Some(1));
        assert_eq!(state.selected_path(), Some(Path::new("root/beta.txt")));
        assert_eq!(state.select_prefix("missing"), None);
        assert_eq!(state.selected_path(), Some(Path::new("root/beta.txt")));
    }
}
