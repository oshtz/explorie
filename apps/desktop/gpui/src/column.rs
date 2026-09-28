use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use explorie_core::FileEntry;

use crate::browser::{BrowserState, EntryListing, SortedOrder, ViewSpec};

#[derive(Debug)]
pub struct ColumnData {
    path: PathBuf,
    listing: EntryListing,
    loading: bool,
    error: Option<String>,
    view: RefCell<ColumnView>,
}

/// The column's sorted, filtered rows, rebuilt only when its listing or the
/// browser's filter, sort, hidden or search settings change.
#[derive(Debug, Default)]
struct ColumnView {
    order: SortedOrder,
    visible: Option<(ViewSpec, Arc<[Arc<FileEntry>]>)>,
    /// The last row looked up by path, which rendering repeats every frame.
    lookup: Option<(PathBuf, Option<Arc<FileEntry>>)>,
}

impl ColumnView {
    fn rows(&mut self, listing: &EntryListing, browser: &BrowserState) -> Arc<[Arc<FileEntry>]> {
        if let Some((spec, rows)) = &self.visible
            && browser.view_matches(spec)
        {
            return Arc::clone(rows);
        }
        let spec = browser.view_spec();
        let order = self
            .order
            .ensure(listing, &spec.sort_key, spec.sort_direction);
        let rows: Arc<[Arc<FileEntry>]> = listing.visible_for(order, &spec).into();
        self.visible = Some((spec, Arc::clone(&rows)));
        self.lookup = None;
        rows
    }

    fn invalidate_rows(&mut self) {
        self.visible = None;
        self.lookup = None;
    }
}

impl ColumnData {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn loading(&self) -> bool {
        self.loading
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn entries(&self) -> &[Arc<FileEntry>] {
        self.listing.entries()
    }

    /// The rows this column shows for the browser's current view. Repeated
    /// calls share one cached slice until the listing or view settings change.
    pub fn visible_entries(&self, browser: &BrowserState) -> Arc<[Arc<FileEntry>]> {
        self.view.borrow_mut().rows(&self.listing, browser)
    }

    /// The visible row for `path`, if this column shows it.
    pub fn visible_entry(&self, browser: &BrowserState, path: &Path) -> Option<Arc<FileEntry>> {
        if path.parent() != Some(self.path.as_path()) {
            return None;
        }
        let mut view = self.view.borrow_mut();
        let rows = view.rows(&self.listing, browser);
        if let Some((cached, entry)) = &view.lookup
            && cached == path
        {
            return entry.clone();
        }
        let entry = rows.iter().find(|entry| entry.path == path).cloned();
        view.lookup = Some((path.to_path_buf(), entry.clone()));
        entry
    }

    fn replace_listing(&mut self, entries: Vec<Arc<FileEntry>>) {
        self.listing = EntryListing::new(entries);
        let view = self.view.get_mut();
        view.order.invalidate();
        view.invalidate_rows();
    }

    fn apply_changes(&mut self, changes: Vec<(PathBuf, Option<FileEntry>)>) -> bool {
        let Some(patch) = self.listing.apply_changes(changes) else {
            return false;
        };
        let view = self.view.get_mut();
        view.order.apply_patch(&self.listing, &patch);
        view.invalidate_rows();
        true
    }
}

#[derive(Debug)]
pub struct ColumnState {
    columns: Vec<ColumnData>,
}

impl ColumnState {
    pub fn new(path: &Path) -> Self {
        Self {
            columns: build_path_stack(path)
                .into_iter()
                .map(empty_column)
                .collect(),
        }
    }

    pub fn reset(&mut self, path: &Path) -> usize {
        let paths = build_path_stack(path);
        let retained = self
            .columns
            .iter()
            .zip(&paths)
            .take_while(|(column, path)| column.path() == path.as_path())
            .count();
        self.columns.truncate(retained);
        self.columns
            .extend(paths.into_iter().skip(retained).map(empty_column));
        self.begin_refresh();
        retained
    }

    pub fn begin_refresh(&mut self) {
        for column in &mut self.columns {
            column.loading = true;
            column.error = None;
        }
    }

    pub fn paths(&self) -> Vec<PathBuf> {
        self.columns
            .iter()
            .map(|column| column.path.clone())
            .collect()
    }

    pub fn columns(&self) -> &[ColumnData] {
        &self.columns
    }

    pub fn apply_listed<E: Into<Arc<FileEntry>>>(&mut self, path: &Path, entries: Vec<E>) -> bool {
        let Some(column) = self.columns.iter_mut().find(|column| column.path == path) else {
            return false;
        };
        column.replace_listing(entries.into_iter().map(Into::into).collect());
        column.loading = false;
        column.error = None;
        true
    }

    /// Patch one column's listing with re-read entries (`None` for removed
    /// paths). Returns false when no column lists `path` or nothing changed.
    pub fn apply_changes(
        &mut self,
        path: &Path,
        changes: Vec<(PathBuf, Option<FileEntry>)>,
    ) -> bool {
        self.columns
            .iter_mut()
            .find(|column| column.path == path)
            .is_some_and(|column| column.apply_changes(changes))
    }

    pub fn apply_failed(&mut self, path: &Path, error: String) -> bool {
        let Some(column) = self.columns.iter_mut().find(|column| column.path == path) else {
            return false;
        };
        column.loading = false;
        column.error = Some(error);
        true
    }

    pub fn active_child_path(&self, index: usize) -> Option<&Path> {
        self.columns.get(index + 1).map(|column| column.path())
    }
}

fn empty_column(path: PathBuf) -> ColumnData {
    ColumnData {
        path,
        listing: EntryListing::default(),
        loading: true,
        error: None,
        view: RefCell::default(),
    }
}

pub fn build_path_stack(path: &Path) -> Vec<PathBuf> {
    let mut stack: Vec<_> = path
        .ancestors()
        .filter(|ancestor| !ancestor.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .collect();
    stack.reverse();
    if stack.is_empty() {
        stack.push(path.to_path_buf());
    }
    stack
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::SystemTime;

    use uuid::Uuid;

    use super::*;

    fn entry(parent: &Path, name: &str) -> FileEntry {
        FileEntry {
            id: Uuid::new_v4(),
            path: parent.join(name),
            size: 0,
            modified: SystemTime::UNIX_EPOCH,
            hidden: false,
            is_dir: true,
            custom: HashMap::new(),
            is_symlink: false,
            is_junction: false,
            link_target: None,
            has_xattrs: false,
            is_package: false,
            link_target_is_dir: false,
            is_cloud_placeholder: false,
            tags: Vec::new(),
        }
    }

    #[test]
    fn relative_path_stack_runs_from_first_component_to_leaf() {
        let path = PathBuf::from("root").join("one").join("two");
        assert_eq!(
            build_path_stack(&path),
            vec![
                PathBuf::from("root"),
                PathBuf::from("root").join("one"),
                path,
            ]
        );
    }

    #[test]
    fn refresh_keeps_previous_rows_until_each_result_arrives() {
        let path = PathBuf::from("root");
        let mut state = ColumnState::new(&path);
        state.apply_listed(&path, vec![entry(&path, "child")]);
        state.begin_refresh();

        let browser = BrowserState::new(path);
        assert!(state.columns()[0].loading());
        assert_eq!(state.columns()[0].visible_entries(&browser).len(), 1);
    }

    #[test]
    fn navigating_preserves_shared_columns_and_discards_closed_descendants() {
        let root = PathBuf::from("root");
        let child = root.join("child");
        let sibling = root.join("sibling");
        let mut state = ColumnState::new(&child);
        state.apply_listed(&root, vec![entry(&root, "child"), entry(&root, "sibling")]);
        state.apply_listed(&child, vec![entry(&child, "file")]);

        assert_eq!(state.reset(&sibling), 1);
        assert_eq!(state.columns()[0].entries().len(), 2);
        assert!(state.columns()[1].entries().is_empty());
        assert!(!state.apply_listed(&child, vec![entry(&child, "late")]));
        assert_eq!(state.reset(&root), 1);
        assert_eq!(state.paths(), vec![root]);
        assert_eq!(state.columns()[0].entries().len(), 2);
    }

    fn names(rows: &[Arc<FileEntry>]) -> Vec<String> {
        rows.iter()
            .map(|entry| crate::browser::file_name(entry))
            .collect()
    }

    #[test]
    fn visible_rows_are_cached_until_the_listing_or_view_changes() {
        let root = PathBuf::from("root");
        let mut state = ColumnState::new(&root);
        let file = |name: &str| FileEntry {
            is_dir: false,
            ..entry(&root, name)
        };
        state.apply_listed(
            &root,
            vec![
                file("file10.txt"),
                file("file9.txt"),
                entry(&root, "folder"),
            ],
        );
        let mut browser = BrowserState::new(root.clone());
        let column = &state.columns()[0];
        let rows = column.visible_entries(&browser);
        assert_eq!(names(&rows), ["folder", "file9.txt", "file10.txt"]);
        assert!(Arc::ptr_eq(&rows, &column.visible_entries(&browser)));

        browser.set_sort(crate::browser::SortKey::Name);
        let descending = column.visible_entries(&browser);
        assert!(!Arc::ptr_eq(&rows, &descending));
        assert_eq!(names(&descending), ["folder", "file10.txt", "file9.txt"]);

        browser.push_search_text("FILE1");
        assert_eq!(names(&column.visible_entries(&browser)), ["file10.txt"]);
        assert!(
            column
                .visible_entry(&browser, &root.join("file10.txt"))
                .is_some()
        );
        assert!(
            column
                .visible_entry(&browser, &root.join("file9.txt"))
                .is_none()
        );
        assert!(
            column
                .visible_entry(&browser, Path::new("elsewhere/file10.txt"))
                .is_none()
        );
        browser.clear_search();
        assert!(
            column
                .visible_entry(&browser, &root.join("file9.txt"))
                .is_some()
        );

        state.apply_listed(&root, vec![file("only.txt")]);
        assert_eq!(
            names(&state.columns()[0].visible_entries(&browser)),
            ["only.txt"]
        );
    }

    #[test]
    fn results_for_paths_outside_the_current_stack_are_rejected() {
        let path = PathBuf::from("root").join("one");
        let mut state = ColumnState::new(&path);
        assert!(!state.apply_listed(Path::new("other"), Vec::<FileEntry>::new()));
        assert!(!state.apply_failed(Path::new("other"), "late".to_string()));
    }
}
