use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};

use crate::{
    BlockingTask, ErrorCode, ServiceContext, ServiceError, ServiceEvent, ServiceEvents,
    ServiceResult,
};

const MAX_CONTENT_BYTES: u64 = 5 * 1024 * 1024;
const MAX_INDEXED_ENTRIES_PER_ROOT: usize = 500_000;
const MAX_CACHED_INDEX_ENTRIES: usize = 1_000_000;
const MAX_SEARCH_RESULTS: usize = 50_000;
const SEARCH_PROGRESS_INTERVAL: usize = 512;
const SEARCH_RESULT_BATCH_SIZE: usize = 128;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchType {
    #[default]
    All,
    Files,
    Folders,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum CombineMode {
    #[default]
    And,
    Or,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCriteria {
    pub name_pattern: Option<String>,
    pub name_regex: bool,
    pub extensions: Vec<String>,
    pub type_filter: SearchType,
    pub size_min: Option<u64>,
    pub size_max: Option<u64>,
    pub modified_after: Option<u64>,
    pub modified_before: Option<u64>,
    pub content_search: Option<String>,
    pub search_paths: Vec<PathBuf>,
    pub recursive: bool,
    pub combine_mode: CombineMode,
    pub exclude_pattern: Option<String>,
}

impl Default for SearchCriteria {
    fn default() -> Self {
        Self {
            name_pattern: None,
            name_regex: false,
            extensions: Vec::new(),
            type_filter: SearchType::All,
            size_min: None,
            size_max: None,
            modified_after: None,
            modified_before: None,
            content_search: None,
            search_paths: Vec::new(),
            recursive: true,
            combine_mode: CombineMode::And,
            exclude_pattern: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SearchResult {
    pub entries: Vec<explorie_core::FileEntry>,
    pub indexed_entries: usize,
    pub content_reads: usize,
    pub reused_index: bool,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SearchIndexHealth {
    pub roots: usize,
    pub indexed_entries: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgressEvent {
    pub request_id: String,
    pub phase: String,
    pub indexed_entries: usize,
    pub matched_entries: usize,
    pub current_path: PathBuf,
    #[serde(default)]
    pub entries: Vec<explorie_core::FileEntry>,
}

struct SearchProgress<'a> {
    events: &'a ServiceEvents,
    request_id: &'a str,
}

impl SearchProgress<'_> {
    fn publish(
        &self,
        phase: &str,
        indexed_entries: usize,
        matched_entries: usize,
        current_path: &Path,
        entries: Vec<explorie_core::FileEntry>,
    ) {
        self.events
            .publish(ServiceEvent::SearchProgress(SearchProgressEvent {
                request_id: self.request_id.to_string(),
                phase: phase.to_string(),
                indexed_entries,
                matched_entries,
                current_path: current_path.to_path_buf(),
                entries,
            }));
    }
}

#[derive(Clone)]
pub struct SearchService {
    context: ServiceContext,
    index: Arc<Mutex<SearchIndex>>,
    generation: Arc<AtomicU64>,
}

impl SearchService {
    pub(crate) fn new(context: ServiceContext) -> Self {
        Self {
            context,
            index: Arc::new(Mutex::new(SearchIndex::default())),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn fork_cancellation_scope(&self) -> Self {
        Self {
            context: self.context.clone(),
            index: Arc::clone(&self.index),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn search(&self, criteria: SearchCriteria) -> BlockingTask<SearchResult> {
        let index = Arc::clone(&self.index);
        let generation = Arc::clone(&self.generation);
        let ticket = generation.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
        self.context
            .spawn_blocking(move || search(&index, criteria, &generation, ticket, None))
    }

    pub fn search_with_progress(
        &self,
        criteria: SearchCriteria,
        request_id: String,
    ) -> BlockingTask<SearchResult> {
        let index = Arc::clone(&self.index);
        let generation = Arc::clone(&self.generation);
        let events = self.context.events();
        let ticket = generation.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
        self.context.spawn_blocking(move || {
            let progress = SearchProgress {
                events: &events,
                request_id: &request_id,
            };
            search(&index, criteria, &generation, ticket, Some(&progress))
        })
    }

    pub fn search_blocking(&self, criteria: SearchCriteria) -> ServiceResult<SearchResult> {
        let ticket = self
            .generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        search(&self.index, criteria, &self.generation, ticket, None)
    }

    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    pub fn invalidate(&self, paths: &[PathBuf]) {
        self.cancel();
        let roots = self
            .index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .roots
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for cached in roots {
            let mut root = cached
                .index
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if paths.iter().any(|path| {
                comparable(path).starts_with(&root.comparable_root)
                    || root.comparable_root.starts_with(&comparable(path))
            }) {
                root.invalidated = true;
            }
        }
    }

    pub fn clear(&self) {
        self.cancel();
        let mut index = self
            .index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        index.roots.clear();
        index.cached_entries = 0;
    }

    pub fn index_health(&self) -> SearchIndexHealth {
        let index = self
            .index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        SearchIndexHealth {
            roots: index.roots.len(),
            indexed_entries: index.cached_entries,
        }
    }
}

#[derive(Default)]
struct SearchIndex {
    roots: HashMap<String, CachedRootIndex>,
    cached_entries: usize,
}

#[derive(Clone)]
struct CachedRootIndex {
    index: Arc<Mutex<RootIndex>>,
    entry_count: usize,
}

struct RootIndex {
    comparable_root: String,
    entries: Vec<IndexedEntry>,
    content_query: Option<String>,
    invalidated: bool,
}

struct IndexedEntry {
    entry: explorie_core::FileEntry,
    content_matches: Option<bool>,
}

enum NameMatcher {
    Contains(String),
    Regex(regex::Regex),
}

impl NameMatcher {
    fn matches(&self, name: &str) -> bool {
        match self {
            Self::Contains(needle) => name.to_lowercase().contains(needle),
            Self::Regex(regex) => regex.is_match(name),
        }
    }
}

fn search(
    index: &Mutex<SearchIndex>,
    criteria: SearchCriteria,
    generation: &AtomicU64,
    ticket: u64,
    progress: Option<&SearchProgress<'_>>,
) -> ServiceResult<SearchResult> {
    let paths: Vec<_> = criteria
        .search_paths
        .iter()
        .filter(|path| !path.as_os_str().is_empty())
        .cloned()
        .collect();
    if paths.is_empty() {
        return Ok(SearchResult {
            entries: Vec::new(),
            indexed_entries: 0,
            content_reads: 0,
            reused_index: true,
            truncated: false,
        });
    }

    let name_matcher = build_matcher(criteria.name_pattern.as_deref(), criteria.name_regex)?;
    let exclude_matcher = build_matcher(criteria.exclude_pattern.as_deref(), criteria.name_regex)?;
    let extensions = normalized_extensions(&criteria.extensions);
    let content_query = criteria
        .content_search
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(str::to_lowercase);
    let mut result_paths = HashSet::new();
    let mut entries = Vec::new();
    let mut indexed_entries = 0;
    let mut content_reads = 0;
    let mut reused_index = true;
    let mut truncated = false;

    for root in paths {
        ensure_search_current(generation, ticket)?;
        let key = format!("{}|{}", comparable(&root), criteria.recursive);
        let cached = index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .roots
            .get(&key)
            .cloned();
        let rebuild = cached.as_ref().is_none_or(|cached| {
            cached
                .index
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .invalidated
        });
        let cached = if rebuild {
            let root_index = build_index(&root, criteria.recursive, generation, ticket, progress)?;
            let entry_count = root_index.entries.len();
            let cached = CachedRootIndex {
                index: Arc::new(Mutex::new(root_index)),
                entry_count,
            };
            let mut index = index
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if index.cached_entries.saturating_add(entry_count) > MAX_CACHED_INDEX_ENTRIES {
                index.roots.clear();
                index.cached_entries = 0;
            }
            if let Some(replaced) = index.roots.insert(key.clone(), cached.clone()) {
                index.cached_entries = index.cached_entries.saturating_sub(replaced.entry_count);
            }
            index.cached_entries = index.cached_entries.saturating_add(entry_count);
            reused_index = false;
            cached
        } else {
            cached.expect("a reusable search index must exist")
        };
        let mut root_index = cached
            .index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if content_query.is_some()
            && root_index.content_query.as_deref() != content_query.as_deref()
        {
            for (index, indexed) in root_index.entries.iter_mut().enumerate() {
                ensure_search_current(generation, ticket)?;
                indexed.content_matches = None;
                if indexed.entry.is_dir || indexed.entry.size > MAX_CONTENT_BYTES {
                    continue;
                }
                indexed.content_matches = content_file_matches(
                    &indexed.entry.path,
                    content_query.as_deref().unwrap_or_default(),
                );
                content_reads += 1;
                if index % SEARCH_PROGRESS_INTERVAL == 0
                    && let Some(progress) = progress
                {
                    progress.publish(
                        "content",
                        indexed_entries + index,
                        entries.len(),
                        &indexed.entry.path,
                        Vec::new(),
                    );
                }
            }
            root_index.content_query = content_query.clone();
            reused_index = false;
        }
        indexed_entries += root_index.entries.len();

        let mut batch = Vec::with_capacity(SEARCH_RESULT_BATCH_SIZE);
        for (index, indexed) in root_index.entries.iter().enumerate() {
            ensure_search_current(generation, ticket)?;
            if !matches_criteria(
                indexed,
                &criteria,
                name_matcher.as_ref(),
                exclude_matcher.as_ref(),
                &extensions,
                content_query.as_deref(),
            ) {
                continue;
            }
            let key = comparable(&indexed.entry.path);
            if result_paths.insert(key) {
                if entries.len() >= MAX_SEARCH_RESULTS {
                    truncated = true;
                    break;
                }
                entries.push(indexed.entry.clone());
                batch.push(indexed.entry.clone());
                if batch.len() == SEARCH_RESULT_BATCH_SIZE {
                    if let Some(progress) = progress {
                        progress.publish(
                            "results",
                            indexed_entries,
                            entries.len(),
                            &indexed.entry.path,
                            std::mem::take(&mut batch),
                        );
                    } else {
                        batch.clear();
                    }
                }
            }
            if index % SEARCH_PROGRESS_INTERVAL == 0
                && let Some(progress) = progress
            {
                progress.publish(
                    "matching",
                    indexed_entries,
                    entries.len(),
                    &indexed.entry.path,
                    Vec::new(),
                );
            }
        }
        if !batch.is_empty()
            && let Some(progress) = progress
        {
            progress.publish("results", indexed_entries, entries.len(), &root, batch);
        }
        if truncated {
            break;
        }
    }

    Ok(SearchResult {
        entries,
        indexed_entries,
        content_reads,
        reused_index,
        truncated,
    })
}

fn content_file_matches(path: &Path, query: &str) -> Option<bool> {
    let mut bytes = Vec::with_capacity(128 * 1024);
    fs::File::open(path)
        .ok()?
        .take(MAX_CONTENT_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_CONTENT_BYTES {
        return None;
    }
    String::from_utf8(bytes)
        .ok()
        .map(|content| content.to_lowercase().contains(query))
}

fn build_index(
    root: &Path,
    recursive: bool,
    generation: &AtomicU64,
    ticket: u64,
    progress: Option<&SearchProgress<'_>>,
) -> ServiceResult<RootIndex> {
    let comparable_root = comparable(root);
    let mut pending = VecDeque::from([root.to_path_buf()]);
    let mut visited = HashSet::new();
    let mut entries = Vec::new();

    while let Some(path) = pending.pop_front() {
        ensure_search_current(generation, ticket)?;
        if !visited.insert(comparable(&path)) {
            continue;
        }
        let Ok(listed) = explorie_core::list_dir_with_sizes(&path, false) else {
            continue;
        };
        for entry in listed {
            ensure_search_current(generation, ticket)?;
            let entry_path = entry.path.clone();
            if recursive && entry.is_dir && !entry.is_symlink && !entry.is_junction {
                pending.push_back(entry_path.clone());
            }
            entries.push(IndexedEntry {
                entry,
                content_matches: None,
            });
            if entries.len() % SEARCH_PROGRESS_INTERVAL == 0
                && let Some(progress) = progress
            {
                progress.publish("indexing", entries.len(), 0, &entry_path, Vec::new());
            }
            if entries.len() > MAX_INDEXED_ENTRIES_PER_ROOT {
                return Err(ServiceError::new(
                    ErrorCode::InvalidInput,
                    format!(
                        "Search root contains more than {MAX_INDEXED_ENTRIES_PER_ROOT} entries"
                    ),
                ));
            }
        }
    }

    Ok(RootIndex {
        comparable_root,
        entries,
        content_query: None,
        invalidated: false,
    })
}

fn ensure_search_current(generation: &AtomicU64, ticket: u64) -> ServiceResult<()> {
    if generation.load(Ordering::Acquire) == ticket {
        Ok(())
    } else {
        Err(ServiceError::new(
            ErrorCode::Cancelled,
            "Search superseded by a newer request",
        ))
    }
}

fn build_matcher(pattern: Option<&str>, regex: bool) -> ServiceResult<Option<NameMatcher>> {
    let Some(pattern) = pattern.map(str::trim).filter(|pattern| !pattern.is_empty()) else {
        return Ok(None);
    };
    if regex {
        RegexBuilder::new(pattern)
            .case_insensitive(true)
            .build()
            .map(NameMatcher::Regex)
            .map(Some)
            .map_err(|error| {
                ServiceError::new(
                    ErrorCode::InvalidInput,
                    format!("Invalid search expression: {error}"),
                )
            })
    } else {
        Ok(Some(NameMatcher::Contains(pattern.to_lowercase())))
    }
}

fn normalized_extensions(extensions: &[String]) -> HashSet<String> {
    extensions
        .iter()
        .map(|extension| extension.trim().to_lowercase())
        .map(|extension| extension.trim_start_matches('.').to_string())
        .filter(|extension| !extension.is_empty())
        .collect()
}

fn matches_criteria(
    indexed: &IndexedEntry,
    criteria: &SearchCriteria,
    name_matcher: Option<&NameMatcher>,
    exclude_matcher: Option<&NameMatcher>,
    extensions: &HashSet<String>,
    content_query: Option<&str>,
) -> bool {
    let entry = &indexed.entry;
    let name = entry
        .path
        .file_name()
        .unwrap_or(entry.path.as_os_str())
        .to_string_lossy();
    if exclude_matcher.is_some_and(|matcher| matcher.matches(&name)) {
        return false;
    }
    let mut checks = Vec::with_capacity(6);
    if let Some(matcher) = name_matcher {
        checks.push(matcher.matches(&name));
    }
    if criteria.type_filter != SearchType::All {
        checks.push(match criteria.type_filter {
            SearchType::All => true,
            SearchType::Files => !entry.is_dir,
            SearchType::Folders => entry.is_dir,
        });
    }
    if !extensions.is_empty() {
        checks.push(
            !entry.is_dir
                && entry
                    .path
                    .extension()
                    .map(|extension| extension.to_string_lossy().to_lowercase())
                    .is_some_and(|extension| extensions.contains(&extension)),
        );
    }
    if criteria.size_min.is_some() || criteria.size_max.is_some() {
        checks.push(
            !entry.is_dir
                && criteria
                    .size_min
                    .is_none_or(|minimum| entry.size >= minimum)
                && criteria
                    .size_max
                    .is_none_or(|maximum| entry.size <= maximum),
        );
    }
    if criteria.modified_after.is_some() || criteria.modified_before.is_some() {
        let modified = millis(entry.modified);
        checks.push(
            criteria
                .modified_after
                .is_none_or(|after| modified >= after)
                && criteria
                    .modified_before
                    .is_none_or(|before| modified <= before),
        );
    }
    if content_query.is_some() {
        checks.push(
            !entry.is_dir
                && entry.size <= MAX_CONTENT_BYTES
                && indexed.content_matches == Some(true),
        );
    }
    if checks.is_empty() {
        return true;
    }
    match criteria.combine_mode {
        CombineMode::And => checks.into_iter().all(|matches| matches),
        CombineMode::Or => checks.into_iter().any(|matches| matches),
    }
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn comparable(path: &Path) -> String {
    let path = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        path.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ResourcePaths;
    use uuid::Uuid;

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("explorie-search-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("alpha.txt"), "needle one").unwrap();
        fs::write(root.join("skip.log"), "needle two").unwrap();
        fs::write(root.join("nested").join("beta.txt"), "other").unwrap();
        root
    }

    fn service(root: &Path) -> SearchService {
        SearchService::new(ServiceContext::new(ResourcePaths::test(root)))
    }

    #[test]
    fn recursive_search_combines_name_extension_type_and_exclusion() {
        let root = fixture();
        let result = service(&root)
            .search_blocking(SearchCriteria {
                name_pattern: Some("a".into()),
                extensions: vec![".txt".into()],
                type_filter: SearchType::Files,
                search_paths: vec![root.clone()],
                recursive: true,
                exclude_pattern: Some("beta".into()),
                ..SearchCriteria::default()
            })
            .unwrap();
        assert_eq!(result.entries.len(), 1);
        assert!(result.entries[0].path.ends_with("alpha.txt"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn content_is_indexed_once_and_invalidated_after_a_watcher_change() {
        let root = fixture();
        let service = service(&root);
        let criteria = SearchCriteria {
            content_search: Some("needle".into()),
            search_paths: vec![root.clone()],
            recursive: true,
            ..SearchCriteria::default()
        };
        let first = service.search_blocking(criteria.clone()).unwrap();
        assert_eq!(first.entries.len(), 2);
        assert_eq!(first.content_reads, 3);
        assert!(!first.reused_index);

        let second = service.search_blocking(criteria.clone()).unwrap();
        assert_eq!(second.entries.len(), 2);
        assert_eq!(second.content_reads, 0);
        assert!(second.reused_index);

        let miss = service
            .search_blocking(SearchCriteria {
                content_search: Some("absent".into()),
                search_paths: vec![root.clone()],
                recursive: true,
                ..SearchCriteria::default()
            })
            .unwrap();
        assert!(miss.entries.is_empty());
        assert_eq!(miss.content_reads, 3);
        assert!(!miss.reused_index);

        fs::write(root.join("nested").join("beta.txt"), "needle three").unwrap();
        service.invalidate(&[root.join("nested").join("beta.txt")]);
        let refreshed = service.search_blocking(criteria).unwrap();
        assert_eq!(refreshed.entries.len(), 3);
        assert_eq!(refreshed.content_reads, 3);
        assert!(!refreshed.reused_index);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_regular_expression_is_a_typed_recoverable_error() {
        let root = fixture();
        let error = service(&root)
            .search_blocking(SearchCriteria {
                name_pattern: Some("[".into()),
                name_regex: true,
                search_paths: vec![root.clone()],
                recursive: true,
                ..SearchCriteria::default()
            })
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ten_thousand_entry_index_query_performs_zero_file_reads() {
        let root = PathBuf::from("indexed-root");
        let key = format!("{}|true", comparable(&root));
        let mut entries: Vec<_> = (0..10_000)
            .map(|index| IndexedEntry {
                entry: explorie_core::FileEntry {
                    id: Uuid::new_v4(),
                    path: root.join(format!("file-{index:05}.txt")),
                    size: 16,
                    modified: UNIX_EPOCH,
                    hidden: false,
                    is_dir: false,
                    custom: HashMap::new(),
                    is_symlink: false,
                    is_junction: false,
                    link_target: None,
                    has_xattrs: false,
                },
                content_matches: Some(index < 3),
            })
            .collect();
        entries.push(IndexedEntry {
            entry: explorie_core::FileEntry {
                id: Uuid::new_v4(),
                path: root.join("oversize.txt"),
                size: MAX_CONTENT_BYTES + 1,
                modified: UNIX_EPOCH,
                hidden: false,
                is_dir: false,
                custom: HashMap::new(),
                is_symlink: false,
                is_junction: false,
                link_target: None,
                has_xattrs: false,
            },
            content_matches: Some(true),
        });
        let index = Mutex::new(SearchIndex {
            roots: HashMap::from([(
                key,
                CachedRootIndex {
                    entry_count: entries.len(),
                    index: Arc::new(Mutex::new(RootIndex {
                        comparable_root: comparable(&root),
                        entries,
                        content_query: Some("needle".to_string()),
                        invalidated: false,
                    })),
                },
            )]),
            cached_entries: 10_001,
        });

        let generation = AtomicU64::new(1);
        let result = search(
            &index,
            SearchCriteria {
                content_search: Some("needle".into()),
                search_paths: vec![root],
                recursive: true,
                ..SearchCriteria::default()
            },
            &generation,
            1,
            None,
        )
        .unwrap();
        assert_eq!(result.indexed_entries, 10_001);
        assert_eq!(result.entries.len(), 3);
        assert_eq!(result.content_reads, 0);
        assert!(result.reused_index);
    }
}
