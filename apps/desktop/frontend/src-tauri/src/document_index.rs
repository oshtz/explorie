use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const INDEX_SCHEMA_VERSION: u32 = 1;
const INDEX_FILE_NAME: &str = "index.json";
const RESCAN_INTERVAL: Duration = Duration::from_secs(1);
const MAX_INDEXED_BYTES: u64 = 128 * 1024 * 1024;
const RETRY_BASE_MS: u64 = 1_000;
const RETRY_MAX_MS: u64 = 60_000;

pub type IndexCompletion = Arc<dyn Fn() + Send + Sync + 'static>;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct DocumentIndexConfig {
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentIndexQueryResult {
    pub paths: Vec<String>,
    pub ready: bool,
    pub indexing: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentIndexStatus {
    pub indexed_documents: usize,
    pub ready: bool,
    pub indexing: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct IndexedDocument {
    path: String,
    size: u64,
    modified_ns: u64,
    terms: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PersistedIndex {
    #[serde(default = "default_schema_version")]
    version: u32,
    #[serde(default)]
    config: DocumentIndexConfig,
    #[serde(default)]
    documents: BTreeMap<String, IndexedDocument>,
    #[serde(default)]
    postings: BTreeMap<String, BTreeSet<String>>,
    #[serde(default)]
    completed_roots: BTreeSet<String>,
    #[serde(default)]
    scanned_at_ms: BTreeMap<String, u64>,
    #[serde(default)]
    retry_attempts: BTreeMap<String, u32>,
    #[serde(default)]
    retry_after_ms: BTreeMap<String, u64>,
}

impl Default for PersistedIndex {
    fn default() -> Self {
        Self {
            version: INDEX_SCHEMA_VERSION,
            config: DocumentIndexConfig::default(),
            documents: BTreeMap::new(),
            postings: BTreeMap::new(),
            completed_roots: BTreeSet::new(),
            scanned_at_ms: BTreeMap::new(),
            retry_attempts: BTreeMap::new(),
            retry_after_ms: BTreeMap::new(),
        }
    }
}

impl PersistedIndex {
    fn rebuild_postings(&mut self) {
        self.postings.clear();
        for (path, document) in &self.documents {
            for term in &document.terms {
                self.postings
                    .entry(term.clone())
                    .or_default()
                    .insert(path.clone());
            }
        }
    }

    fn remove_document(&mut self, path: &str) {
        let Some(document) = self.documents.remove(path) else {
            return;
        };
        for term in document.terms {
            let mut remove_term = false;
            if let Some(paths) = self.postings.get_mut(&term) {
                paths.remove(path);
                remove_term = paths.is_empty();
            }
            if remove_term {
                self.postings.remove(&term);
            }
        }
    }

    fn insert_document(&mut self, key: String, document: IndexedDocument) {
        self.remove_document(&key);
        for term in &document.terms {
            self.postings
                .entry(term.clone())
                .or_default()
                .insert(key.clone());
        }
        self.documents.insert(key, document);
    }

    fn query(&self, roots: &[PathBuf], query: &str) -> Vec<String> {
        let terms = tokenize(query);
        if terms.is_empty() {
            return Vec::new();
        }

        let postings = terms
            .iter()
            .map(|term| {
                self.postings
                    .iter()
                    .filter(|(indexed_term, _)| indexed_term.contains(term))
                    .flat_map(|(_, paths)| paths.iter().cloned())
                    .collect::<BTreeSet<_>>()
            })
            .collect::<Vec<_>>();
        let Some(first_posting) = postings.iter().min_by_key(|paths| paths.len()) else {
            return Vec::new();
        };

        first_posting
            .iter()
            .filter(|path| {
                postings.iter().all(|paths| paths.contains(*path))
                    && roots
                        .iter()
                        .any(|root| path_is_under(root, Path::new(path)))
            })
            .filter(|path| {
                roots
                    .iter()
                    .any(|root| is_allowed_file(root, Path::new(path), &self.config))
            })
            .filter_map(|path| {
                self.documents
                    .get(path)
                    .map(|document| document.path.clone())
            })
            .collect()
    }
}

#[derive(Default)]
struct ManagerState {
    cache_path: Option<PathBuf>,
    initialized: bool,
    data: PersistedIndex,
    config_generation: u64,
    known_roots: BTreeMap<String, PathBuf>,
}

#[derive(Default)]
struct PendingWork {
    roots: BTreeMap<String, PathBuf>,
    callbacks: Vec<IndexCompletion>,
}

#[derive(Clone, Default)]
pub struct DocumentIndexManager {
    state: Arc<Mutex<ManagerState>>,
    pending: Arc<Mutex<PendingWork>>,
    worker_running: Arc<AtomicBool>,
}

impl DocumentIndexManager {
    pub fn default_cache_path(app_cache_dir: &Path) -> PathBuf {
        app_cache_dir.join("document-index").join(INDEX_FILE_NAME)
    }

    pub fn initialize(&self, cache_path: PathBuf) -> Result<(), String> {
        let mut state = lock(&self.state);
        if state.initialized {
            if state.cache_path.as_ref() != Some(&cache_path) {
                return Err("Document index is already attached to another cache path.".to_string());
            }
            return Ok(());
        }

        state.data = load_index(&cache_path);
        if state.data.version != INDEX_SCHEMA_VERSION {
            state.data = PersistedIndex::default();
        }
        state.data.rebuild_postings();
        state.cache_path = Some(cache_path);
        state.initialized = true;
        Ok(())
    }

    pub fn configure(&self, config: DocumentIndexConfig) -> Result<(), String> {
        let normalized = normalize_config(config);
        let (changed, roots_to_reschedule) = {
            let mut state = lock(&self.state);
            ensure_initialized(&state)?;
            if state.data.config == normalized {
                (false, Vec::new())
            } else {
                state.data.config = normalized;
                state.data.completed_roots.clear();
                state.data.scanned_at_ms.clear();
                state.data.retry_attempts.clear();
                state.data.retry_after_ms.clear();
                state.config_generation = state.config_generation.wrapping_add(1);
                (true, state.known_roots.values().cloned().collect())
            }
        };
        if changed {
            self.persist();
            if !roots_to_reschedule.is_empty() {
                self.schedule(roots_to_reschedule, None);
            }
        }
        Ok(())
    }

    pub fn query(
        &self,
        roots: Vec<PathBuf>,
        query: &str,
        callback: Option<IndexCompletion>,
    ) -> Result<DocumentIndexQueryResult, String> {
        let roots = deduplicate_paths(roots);
        if roots.is_empty() {
            return Ok(DocumentIndexQueryResult {
                ready: true,
                ..DocumentIndexQueryResult::default()
            });
        }

        let now = now_ms();
        let roots_to_schedule = {
            let mut state = lock(&self.state);
            ensure_initialized(&state)?;
            for root in &roots {
                state
                    .known_roots
                    .entry(normalize_path(root))
                    .or_insert_with(|| root.clone());
            }
            roots
                .iter()
                .filter(|root| {
                    let key = normalize_path(root);
                    if state
                        .data
                        .retry_after_ms
                        .get(&key)
                        .is_some_and(|retry_after| *retry_after > now)
                    {
                        return false;
                    }
                    let stale = state
                        .data
                        .scanned_at_ms
                        .get(&key)
                        .map(|scanned| {
                            now.saturating_sub(*scanned) >= RESCAN_INTERVAL.as_millis() as u64
                        })
                        .unwrap_or(true);
                    if stale {
                        state.data.completed_roots.remove(&key);
                        state.data.scanned_at_ms.remove(&key);
                        state.data.retry_after_ms.remove(&key);
                    }
                    stale
                })
                .cloned()
                .collect::<Vec<_>>()
        };

        if !roots_to_schedule.is_empty() {
            self.schedule(roots_to_schedule, callback);
        }

        let state = lock(&self.state);
        let ready = roots
            .iter()
            .all(|root| state.data.completed_roots.contains(&normalize_path(root)));
        let paths = state.data.query(&roots, query);
        let indexing = self.worker_running.load(Ordering::Acquire);
        Ok(DocumentIndexQueryResult {
            paths,
            ready,
            indexing,
        })
    }

    pub fn status(&self, roots: Vec<PathBuf>) -> Result<DocumentIndexStatus, String> {
        let roots = deduplicate_paths(roots);
        let state = lock(&self.state);
        ensure_initialized(&state)?;
        let ready = roots
            .iter()
            .all(|root| state.data.completed_roots.contains(&normalize_path(root)));
        Ok(DocumentIndexStatus {
            indexed_documents: state.data.documents.len(),
            ready,
            indexing: self.worker_running.load(Ordering::Acquire),
        })
    }

    pub fn build_now(&self, roots: Vec<PathBuf>) -> Result<(), String> {
        let roots = deduplicate_paths(roots);
        {
            let mut state = lock(&self.state);
            ensure_initialized(&state)?;
            for root in &roots {
                state
                    .known_roots
                    .entry(normalize_path(root))
                    .or_insert_with(|| root.clone());
            }
        }
        for root in roots {
            self.scan_root(&root);
        }
        Ok(())
    }

    fn schedule(&self, roots: Vec<PathBuf>, callback: Option<IndexCompletion>) {
        let mut pending = lock(&self.pending);
        for root in roots {
            pending.roots.entry(normalize_path(&root)).or_insert(root);
        }
        if let Some(callback) = callback {
            pending.callbacks.push(callback);
        }
        drop(pending);

        if !self.worker_running.swap(true, Ordering::AcqRel) {
            let manager = self.clone();
            let _ = thread::Builder::new()
                .name("explorie-document-index".to_string())
                .spawn(move || manager.worker_loop());
        }
    }

    fn worker_loop(&self) {
        loop {
            let roots = {
                let mut pending = lock(&self.pending);
                if pending.roots.is_empty() {
                    self.worker_running.store(false, Ordering::Release);
                    return;
                }
                std::mem::take(&mut pending.roots)
                    .into_values()
                    .collect::<Vec<_>>()
            };

            for root in roots {
                self.scan_root(&root);
            }

            let callbacks = {
                let mut pending = lock(&self.pending);
                if pending.roots.is_empty() {
                    std::mem::take(&mut pending.callbacks)
                } else {
                    Vec::new()
                }
            };
            for callback in callbacks {
                callback();
            }
        }
    }

    fn scan_root(&self, root: &Path) {
        let (config, generation, cache_root) = {
            let state = lock(&self.state);
            if !state.initialized {
                return;
            }
            (
                state.data.config.clone(),
                state.config_generation,
                state
                    .cache_path
                    .as_ref()
                    .and_then(|path| path.parent().map(Path::to_path_buf)),
            )
        };

        let root_key = normalize_path(root);
        if let Err(error) = fs::symlink_metadata(root) {
            if error.kind() == io::ErrorKind::NotFound {
                let restart = {
                    let mut state = lock(&self.state);
                    if state.config_generation != generation {
                        true
                    } else {
                        remove_documents_under_root(&mut state.data, root, &HashSet::new());
                        state.data.completed_roots.insert(root_key.clone());
                        state.data.scanned_at_ms.insert(root_key.clone(), now_ms());
                        state.data.retry_attempts.remove(&root_key);
                        state.data.retry_after_ms.remove(&root_key);
                        false
                    }
                };
                if restart {
                    self.schedule(vec![root.to_path_buf()], None);
                } else {
                    self.persist();
                }
            } else {
                self.record_scan_failure(root, generation);
            }
            return;
        }

        let mut stack = vec![root.to_path_buf()];
        let mut seen = HashSet::new();
        let mut reliable = true;

        while let Some(path) = stack.pop() {
            if cache_root
                .as_ref()
                .is_some_and(|cache_root| path_is_under(cache_root, &path))
            {
                continue;
            }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    reliable = false;
                    continue;
                }
            };

            if metadata.is_dir() {
                if path != root && is_excluded(root, &path, &config) {
                    continue;
                }
                match fs::read_dir(&path) {
                    Ok(entries) => {
                        for entry in entries {
                            match entry {
                                Ok(entry) => stack.push(entry.path()),
                                Err(_) => reliable = false,
                            }
                        }
                    }
                    Err(_) => reliable = false,
                }
                continue;
            }

            if !metadata.is_file() || !is_allowed_file(root, &path, &config) {
                continue;
            }

            let path_key = normalize_path(&path);
            seen.insert(path_key.clone());
            let size = metadata.len();
            let modified_ns = modified_ns(&metadata);
            let unchanged = {
                let state = lock(&self.state);
                state.data.documents.get(&path_key).is_some_and(|document| {
                    document.size == size && document.modified_ns == modified_ns
                })
            };
            if unchanged {
                thread::yield_now();
                continue;
            }

            let terms = read_document_terms(&path);
            let mut state = lock(&self.state);
            state.data.remove_document(&path_key);
            if let Some(terms) = terms {
                state.data.insert_document(
                    path_key,
                    IndexedDocument {
                        path: path.to_string_lossy().into_owned(),
                        size,
                        modified_ns,
                        terms,
                    },
                );
            }
            drop(state);
            thread::yield_now();
        }

        let restart = {
            let mut state = lock(&self.state);
            if state.config_generation != generation {
                true
            } else if reliable {
                remove_documents_under_root(&mut state.data, root, &seen);
                state.data.completed_roots.insert(root_key.clone());
                state.data.scanned_at_ms.insert(root_key.clone(), now_ms());
                state.data.retry_attempts.remove(&root_key);
                state.data.retry_after_ms.remove(&root_key);
                false
            } else {
                state.data.completed_roots.remove(&root_key);
                state.data.scanned_at_ms.remove(&root_key);
                let attempts = {
                    let entry = state
                        .data
                        .retry_attempts
                        .entry(root_key.clone())
                        .or_insert(0);
                    *entry = entry.saturating_add(1);
                    *entry
                };
                state.data.retry_after_ms.insert(
                    root_key.clone(),
                    now_ms().saturating_add(retry_delay_ms(attempts)),
                );
                false
            }
        };
        if restart {
            self.schedule(vec![root.to_path_buf()], None);
        } else {
            self.persist();
        }

        // Keep this worker cooperative. A dedicated thread prevents a large scan from consuming
        // the Tauri blocking pool, while yielding after each file lets foreground work run first.
    }

    fn record_scan_failure(&self, root: &Path, generation: u64) {
        let root_key = normalize_path(root);
        let restart = {
            let mut state = lock(&self.state);
            if state.config_generation != generation {
                true
            } else {
                state.data.completed_roots.remove(&root_key);
                state.data.scanned_at_ms.remove(&root_key);
                let attempts = {
                    let entry = state
                        .data
                        .retry_attempts
                        .entry(root_key.clone())
                        .or_insert(0);
                    *entry = entry.saturating_add(1);
                    *entry
                };
                state
                    .data
                    .retry_after_ms
                    .insert(root_key, now_ms().saturating_add(retry_delay_ms(attempts)));
                false
            }
        };
        if restart {
            self.schedule(vec![root.to_path_buf()], None);
        } else {
            self.persist();
        }
    }

    fn persist(&self) {
        let (Some(path), data) = ({
            let state = lock(&self.state);
            (state.cache_path.clone(), state.data.clone())
        }) else {
            return;
        };
        let _ = save_index(&path, &data);
    }
}

fn default_schema_version() -> u32 {
    INDEX_SCHEMA_VERSION
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn ensure_initialized(state: &ManagerState) -> Result<(), String> {
    if state.initialized {
        Ok(())
    } else {
        Err("Document index is not initialized.".to_string())
    }
}

fn load_index(path: &Path) -> PersistedIndex {
    let Ok(contents) = fs::read_to_string(path) else {
        return PersistedIndex::default();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn save_index(path: &Path, data: &PersistedIndex) -> io::Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("json.tmp");
    let payload = serde_json::to_vec(data).map_err(io::Error::other)?;
    let mut file = File::create(&temporary)?;
    file.write_all(&payload)?;
    file.sync_all()?;
    drop(file);

    #[cfg(windows)]
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(temporary, path)
}

fn normalize_config(config: DocumentIndexConfig) -> DocumentIndexConfig {
    fn normalize_patterns(patterns: Vec<String>) -> Vec<String> {
        let mut values = patterns
            .into_iter()
            .map(|pattern| pattern.trim().replace('\\', "/"))
            .filter(|pattern| !pattern.is_empty())
            .collect::<Vec<_>>();
        values.sort();
        values.dedup();
        values
    }

    DocumentIndexConfig {
        include_patterns: normalize_patterns(config.include_patterns),
        exclude_patterns: normalize_patterns(config.exclude_patterns),
    }
}

fn deduplicate_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(normalize_path(path)))
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn retry_delay_ms(attempts: u32) -> u64 {
    let exponent = attempts.saturating_sub(1).min(6);
    RETRY_BASE_MS
        .saturating_mul(1u64 << exponent)
        .min(RETRY_MAX_MS)
}

fn modified_ns(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or_default()
}

fn normalize_path(path: &Path) -> String {
    let mut normalized = path.to_string_lossy().replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    #[cfg(windows)]
    {
        normalized.make_ascii_lowercase();
    }
    normalized
}

fn path_is_under(root: &Path, path: &Path) -> bool {
    let root = normalize_path(root);
    let path = normalize_path(path);
    if root == "/" {
        return path.starts_with('/');
    }
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn relative_path(root: &Path, path: &Path) -> String {
    let root = normalize_path(root);
    let path = normalize_path(path);
    path.strip_prefix(&root)
        .map(|suffix| suffix.trim_start_matches('/').to_string())
        .unwrap_or(path)
}

fn is_excluded(root: &Path, path: &Path, config: &DocumentIndexConfig) -> bool {
    config
        .exclude_patterns
        .iter()
        .any(|pattern| matches_path_pattern(root, path, pattern, true))
}

fn is_allowed_file(root: &Path, path: &Path, config: &DocumentIndexConfig) -> bool {
    if is_excluded(root, path, config) || !is_indexable_extension(path) {
        return false;
    }
    config.include_patterns.is_empty()
        || config
            .include_patterns
            .iter()
            .any(|pattern| matches_path_pattern(root, path, pattern, false))
}

fn matches_path_pattern(root: &Path, path: &Path, pattern: &str, directory: bool) -> bool {
    let relative = relative_path(root, path);
    let full = normalize_path(path);
    let normalized_pattern = pattern.trim_matches('/').replace('\\', "/");
    if normalized_pattern.is_empty() {
        return false;
    }

    let mut patterns = vec![normalized_pattern.clone()];
    patterns.push(normalized_pattern.replace("**/", ""));
    patterns.push(normalized_pattern.replace("**", "*"));
    if directory {
        patterns.push(
            normalized_pattern
                .strip_suffix("/**")
                .unwrap_or(&normalized_pattern)
                .to_string(),
        );
    }
    patterns.sort();
    patterns.dedup();

    let basename = Path::new(&relative)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&relative);
    patterns.iter().any(|candidate| {
        if !candidate.contains('/') {
            glob_match(basename, candidate)
                || relative
                    .split('/')
                    .any(|component| glob_match(component, candidate))
        } else {
            glob_match(&relative, candidate) || glob_match(&full, candidate)
        }
    })
}

fn glob_match(text: &str, pattern: &str) -> bool {
    let text = text.chars().collect::<Vec<_>>();
    let pattern = pattern.chars().collect::<Vec<_>>();
    let mut text_index = 0;
    let mut pattern_index = 0;
    let mut star_index: Option<usize> = None;
    let mut star_text_index = 0;

    while text_index < text.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == '?'
                || equal_pattern_char(text[text_index], pattern[pattern_index]))
        {
            text_index += 1;
            pattern_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == '*' {
            star_index = Some(pattern_index);
            star_text_index = text_index;
            pattern_index += 1;
        } else if let Some(star) = star_index {
            pattern_index = star + 1;
            star_text_index += 1;
            text_index = star_text_index;
        } else {
            return false;
        }
    }

    while pattern_index < pattern.len() && pattern[pattern_index] == '*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

fn equal_pattern_char(left: char, right: char) -> bool {
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(&right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn is_indexable_extension(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return true;
    };
    let extension = extension.to_ascii_lowercase();
    // PDF and Office extraction stays deferred until an optional helper is present; the indexer
    // never shells out and never treats a binary container as searchable UTF-8 text.
    if matches!(
        extension.as_str(),
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp"
    ) {
        return false;
    }
    !matches!(
        extension.as_str(),
        "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "webp"
            | "bmp"
            | "tif"
            | "tiff"
            | "heic"
            | "heif"
            | "avif"
            | "mp3"
            | "wav"
            | "flac"
            | "ogg"
            | "mp4"
            | "mov"
            | "avi"
            | "mkv"
            | "webm"
            | "zip"
            | "tar"
            | "gz"
            | "7z"
            | "rar"
            | "exe"
            | "dll"
            | "so"
            | "dylib"
    )
}

fn read_document_terms(path: &Path) -> Option<Vec<String>> {
    let file = File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_INDEXED_BYTES {
        return None;
    }

    let mut bytes = Vec::new();
    file.take(MAX_INDEXED_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_INDEXED_BYTES || bytes.contains(&0) {
        return None;
    }
    Some(tokenize(&String::from_utf8_lossy(&bytes)))
}

fn tokenize(text: &str) -> Vec<String> {
    let mut terms = BTreeSet::new();
    let mut current = String::new();
    for character in text.chars() {
        if character.is_alphanumeric() {
            current.extend(character.to_lowercase());
        } else if !current.is_empty() {
            terms.insert(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        terms.insert(current);
    }
    terms.into_iter().collect()
}

fn remove_documents_under_root(data: &mut PersistedIndex, root: &Path, seen: &HashSet<String>) {
    let stale = data
        .documents
        .keys()
        .filter(|path| path_is_under(root, Path::new(path)) && !seen.contains(path.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    for path in stale {
        data.remove_document(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "explorie-document-index-{name}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
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

    fn query(manager: &DocumentIndexManager, root: &Path, terms: &str) -> Vec<String> {
        manager
            .query(vec![root.to_path_buf()], terms, None)
            .unwrap()
            .paths
    }

    #[test]
    fn build_and_query_index_supports_multi_word_content() {
        let root = TempDir::new("build");
        fs::write(root.0.join("invoice.txt"), "Invoice for fiscal year 2024").unwrap();
        fs::write(
            root.0.join("old-invoice.txt"),
            "Invoice for fiscal year 2023",
        )
        .unwrap();
        fs::write(root.0.join("image.png"), b"invoice 2024").unwrap();
        fs::write(root.0.join("report.pdf"), b"invoice 2024").unwrap();
        fs::write(root.0.join("report.docx"), b"invoice 2024").unwrap();

        let manager = DocumentIndexManager::default();
        manager
            .initialize(root.0.join("cache").join("index.json"))
            .unwrap();
        manager.build_now(vec![root.0.clone()]).unwrap();

        assert_eq!(
            query(&manager, &root.0, "invoice 2024"),
            vec![root.0.join("invoice.txt").to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn incremental_build_updates_changed_and_removed_documents() {
        let root = TempDir::new("incremental");
        let invoice = root.0.join("invoice.txt");
        let second = root.0.join("second.txt");
        fs::write(&invoice, "invoice 2024").unwrap();
        fs::write(&second, "invoice 2024").unwrap();

        let manager = DocumentIndexManager::default();
        manager
            .initialize(root.0.join("cache").join("index.json"))
            .unwrap();
        manager.build_now(vec![root.0.clone()]).unwrap();
        assert_eq!(query(&manager, &root.0, "invoice 2024").len(), 2);

        fs::write(&invoice, "other phrase").unwrap();
        fs::remove_file(&second).unwrap();
        manager.build_now(vec![root.0.clone()]).unwrap();
        assert!(query(&manager, &root.0, "invoice 2024").is_empty());
    }

    #[test]
    fn include_and_exclude_patterns_are_applied_without_touching_user_directories() {
        let root = TempDir::new("patterns");
        fs::create_dir_all(root.0.join("private")).unwrap();
        fs::write(root.0.join("keep.md"), "invoice 2024").unwrap();
        fs::write(root.0.join("keep.txt"), "invoice 2024").unwrap();
        fs::write(root.0.join("private").join("secret.md"), "invoice 2024").unwrap();
        let cache = TempDir::new("patterns-cache");

        let manager = DocumentIndexManager::default();
        manager.initialize(cache.0.join("index.json")).unwrap();
        manager
            .configure(DocumentIndexConfig {
                include_patterns: vec!["**/*.md".to_string()],
                exclude_patterns: vec!["private/**".to_string()],
            })
            .unwrap();
        manager.build_now(vec![root.0.clone()]).unwrap();

        assert_eq!(
            query(&manager, &root.0, "invoice 2024"),
            vec![root.0.join("keep.md").to_string_lossy().into_owned()]
        );
        assert!(cache.0.join("index.json").is_file());
        assert!(!root.0.join("index.json").exists());
    }

    #[test]
    fn persisted_index_can_be_loaded_for_query_without_rereading_documents() {
        let root = TempDir::new("persist");
        let cache = TempDir::new("persist-cache");
        let document = root.0.join("invoice.txt");
        fs::write(&document, "invoice 2024").unwrap();

        let first = DocumentIndexManager::default();
        first.initialize(cache.0.join("index.json")).unwrap();
        first.build_now(vec![root.0.clone()]).unwrap();
        drop(first);

        fs::remove_file(&document).unwrap();
        let second = DocumentIndexManager::default();
        second.initialize(cache.0.join("index.json")).unwrap();
        assert_eq!(
            query(&second, &root.0, "invoice 2024"),
            vec![document.to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn content_larger_than_the_old_five_megabyte_cap_is_indexed() {
        let root = TempDir::new("large");
        let document = root.0.join("large.txt");
        let mut content = vec![b'x'; 5 * 1024 * 1024 + 1];
        content.extend_from_slice(b" invoice 2024");
        fs::write(&document, content).unwrap();

        let manager = DocumentIndexManager::default();
        manager
            .initialize(root.0.join("cache").join("index.json"))
            .unwrap();
        manager.build_now(vec![root.0.clone()]).unwrap();
        assert_eq!(
            query(&manager, &root.0, "invoice 2024"),
            vec![document.to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn path_containment_handles_posix_root_and_component_boundaries() {
        assert!(path_is_under(
            Path::new("/"),
            Path::new("/tmp/document.txt")
        ));
        assert!(path_is_under(
            Path::new("/tmp"),
            Path::new("/tmp/document.txt")
        ));
        assert!(!path_is_under(
            Path::new("/tmp"),
            Path::new("/tmp2/document.txt")
        ));
    }

    #[test]
    fn oversized_documents_are_rejected_before_content_read() {
        let root = TempDir::new("oversized");
        let document = root.0.join("oversized.txt");
        let file = File::create(&document).unwrap();
        file.set_len(MAX_INDEXED_BYTES + 1).unwrap();

        assert!(read_document_terms(&document).is_none());
    }

    #[test]
    fn content_query_starts_a_background_build_and_notifies_when_ready() {
        let root = TempDir::new("background");
        let cache = TempDir::new("background-cache");
        let document = root.0.join("invoice.txt");
        fs::write(&document, "invoice 2024").unwrap();

        let manager = DocumentIndexManager::default();
        manager.initialize(cache.0.join("index.json")).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let callback: IndexCompletion = Arc::new(move || {
            let _ = sender.send(());
        });

        let initial = manager
            .query(vec![root.0.clone()], "invoice 2024", Some(callback))
            .unwrap();
        assert!(!initial.ready || initial.paths == vec![document.to_string_lossy().into_owned()]);
        receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("background index completion");

        let ready = manager
            .query(vec![root.0.clone()], "invoice 2024", None)
            .unwrap();
        assert!(ready.ready);
        assert_eq!(ready.paths, vec![document.to_string_lossy().into_owned()]);
    }

    #[test]
    fn unreliable_scans_back_off_instead_of_rescheduling_every_query() {
        let root = TempDir::new("retry");
        let cache = TempDir::new("retry-cache");
        let manager = DocumentIndexManager::default();
        manager.initialize(cache.0.join("index.json")).unwrap();

        let generation = lock(&manager.state).config_generation;
        manager.record_scan_failure(&root.0, generation);

        let key = normalize_path(&root.0);
        let state = lock(&manager.state);
        assert_eq!(state.data.retry_attempts.get(&key), Some(&1));
        assert!(
            state
                .data
                .retry_after_ms
                .get(&key)
                .is_some_and(|retry_after| *retry_after > now_ms())
        );
        drop(state);

        let result = manager
            .query(vec![root.0.clone()], "invoice", None)
            .unwrap();
        assert!(!result.ready);
        assert!(!result.indexing);
        assert!(lock(&manager.pending).roots.is_empty());
        assert_eq!(retry_delay_ms(1), RETRY_BASE_MS);
        assert_eq!(retry_delay_ms(2), RETRY_BASE_MS * 2);
        assert_eq!(retry_delay_ms(u32::MAX), RETRY_MAX_MS);
    }

    #[test]
    fn config_changes_requeue_known_roots_for_the_new_generation() {
        let root = TempDir::new("config-generation");
        let cache = TempDir::new("config-generation-cache");
        fs::write(root.0.join("invoice.txt"), "invoice 2024").unwrap();

        let manager = DocumentIndexManager::default();
        manager.initialize(cache.0.join("index.json")).unwrap();
        manager.build_now(vec![root.0.clone()]).unwrap();

        manager
            .configure(DocumentIndexConfig {
                include_patterns: vec!["**/*.md".to_string()],
                exclude_patterns: Vec::new(),
            })
            .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let status = manager.status(vec![root.0.clone()]).unwrap();
            if status.ready {
                assert_eq!(status.indexed_documents, 0);
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "config scan did not complete"
            );
            thread::sleep(Duration::from_millis(10));
        }

        assert!(query(&manager, &root.0, "invoice 2024").is_empty());
    }
}
