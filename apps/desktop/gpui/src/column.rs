use std::path::{Path, PathBuf};

use explorie_core::FileEntry;

use crate::browser::{BrowserState, filtered_sorted_entries};

#[derive(Debug)]
pub struct ColumnData {
    path: PathBuf,
    entries: Vec<FileEntry>,
    loading: bool,
    error: Option<String>,
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

    pub fn entries(&self) -> &[FileEntry] {
        &self.entries
    }

    pub fn visible_entries(&self, browser: &BrowserState) -> Vec<FileEntry> {
        filtered_sorted_entries(
            &self.entries,
            browser.show_hidden(),
            browser.show_system_files(),
            browser.filter(),
            &browser.sort_key(),
            browser.sort_direction(),
            browser.search_query(),
        )
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

    pub fn apply_listed(&mut self, path: &Path, entries: Vec<FileEntry>) -> bool {
        let Some(column) = self.columns.iter_mut().find(|column| column.path == path) else {
            return false;
        };
        column.entries = entries;
        column.loading = false;
        column.error = None;
        true
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
        entries: Vec::new(),
        loading: true,
        error: None,
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

    #[test]
    fn results_for_paths_outside_the_current_stack_are_rejected() {
        let path = PathBuf::from("root").join("one");
        let mut state = ColumnState::new(&path);
        assert!(!state.apply_listed(Path::new("other"), Vec::new()));
        assert!(!state.apply_failed(Path::new("other"), "late".to_string()));
    }
}
