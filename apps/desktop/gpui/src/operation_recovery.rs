use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use explorie_native_services::{ConflictPolicy, FileOperationKind, FileOperationRequest};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const JOURNAL_FILE: &str = "operation-recovery-v1.json";
const JOURNAL_VERSION: u32 = 1;
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RecoveryDisposition {
    SafeToRetry,
    CompletedMove,
    NeedsReview,
}

#[derive(Clone, Debug)]
pub(crate) struct InterruptedOperation {
    id: String,
    request: FileOperationRequest,
    disposition: RecoveryDisposition,
    disposable_stages: Vec<PathBuf>,
}

impl InterruptedOperation {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn request(&self) -> &FileOperationRequest {
        &self.request
    }

    pub(crate) fn disposition(&self) -> RecoveryDisposition {
        self.disposition
    }

    pub(crate) fn prepare_retry(&self) -> io::Result<()> {
        if self.disposition != RecoveryDisposition::SafeToRetry {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "interrupted operation is not safe to retry",
            ));
        }
        for stage in &self.disposable_stages {
            remove_path(stage)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct JournalEntry {
    id: String,
    request: FileOperationRequest,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct JournalSnapshot {
    version: u32,
    entries: Vec<JournalEntry>,
}

#[derive(Clone)]
pub(crate) struct OperationRecoveryStore {
    state: Arc<Mutex<OperationRecoveryState>>,
}

struct OperationRecoveryState {
    path: PathBuf,
    entries: Vec<JournalEntry>,
}

impl OperationRecoveryStore {
    pub(crate) fn open(
        config_dir: &Path,
    ) -> (Option<Self>, Vec<InterruptedOperation>, Option<String>) {
        let path = config_dir.join(JOURNAL_FILE);
        let entries = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<JournalSnapshot>(&bytes) {
                Ok(snapshot) if snapshot.version == JOURNAL_VERSION => snapshot.entries,
                Ok(snapshot) => {
                    return (
                        None,
                        Vec::new(),
                        Some(format!(
                            "Interrupted-operation recovery unavailable; unsupported journal version {} was preserved",
                            snapshot.version
                        )),
                    );
                }
                Err(error) => {
                    return (
                        None,
                        Vec::new(),
                        Some(format!(
                            "Interrupted-operation recovery unavailable; the existing journal was preserved: {error}"
                        )),
                    );
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return (
                    None,
                    Vec::new(),
                    Some(format!(
                        "Interrupted-operation recovery unavailable: {error}"
                    )),
                );
            }
        };
        let interrupted = entries.iter().map(classify_entry).collect();
        (
            Some(Self {
                state: Arc::new(Mutex::new(OperationRecoveryState { path, entries })),
            }),
            interrupted,
            None,
        )
    }

    pub(crate) fn record(&self, request: &FileOperationRequest) -> io::Result<Vec<String>> {
        if request.kind == FileOperationKind::Trash {
            return Ok(Vec::new());
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous_len = state.entries.len();
        let ids = request
            .sources
            .iter()
            .map(|source| {
                let id = Uuid::new_v4().to_string();
                let mut request = request.clone();
                request.sources = vec![source.clone()];
                state.entries.push(JournalEntry {
                    id: id.clone(),
                    request,
                });
                id
            })
            .collect::<Vec<_>>();
        if let Err(error) = state.persist() {
            state.entries.truncate(previous_len);
            return Err(error);
        }
        Ok(ids)
    }

    pub(crate) fn remove(&self, ids: &[String]) -> io::Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = state.entries.clone();
        state
            .entries
            .retain(|entry| !ids.iter().any(|id| id == &entry.id));
        if state.entries.len() == previous.len() {
            return Ok(());
        }
        if let Err(error) = state.persist() {
            state.entries = previous;
            return Err(error);
        }
        Ok(())
    }
}

impl OperationRecoveryState {
    fn persist(&self) -> io::Result<()> {
        if self.entries.is_empty() {
            return match fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            };
        }
        let bytes = serde_json::to_vec_pretty(&JournalSnapshot {
            version: JOURNAL_VERSION,
            entries: self.entries.clone(),
        })
        .map_err(io::Error::other)?;
        atomic_write(&self.path, &bytes)
    }
}

fn classify_entry(entry: &JournalEntry) -> InterruptedOperation {
    let disposition = classify_request(&entry.request);
    let disposable_stages = if disposition == RecoveryDisposition::SafeToRetry {
        disposable_stages(&entry.request)
    } else {
        Vec::new()
    };
    InterruptedOperation {
        id: entry.id.clone(),
        request: entry.request.clone(),
        disposition,
        disposable_stages,
    }
}

fn disposable_stages(request: &FileOperationRequest) -> Vec<PathBuf> {
    let Some(destination) = request.destination.as_ref() else {
        return Vec::new();
    };
    let purpose = match request.kind {
        FileOperationKind::Copy => "copy",
        FileOperationKind::Move => "move",
        FileOperationKind::Trash => return Vec::new(),
    };
    let prefix = format!(".explorie-{purpose}-");
    let Ok(entries) = fs::read_dir(destination) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let suffix = name.strip_prefix(&prefix)?;
            Uuid::parse_str(suffix).ok()?;
            Some(entry.path())
        })
        .collect()
}

fn remove_path(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn classify_request(request: &FileOperationRequest) -> RecoveryDisposition {
    if request.sources.len() != 1
        || request.conflict_policy != ConflictPolicy::Error
        || !matches!(
            request.kind,
            FileOperationKind::Copy | FileOperationKind::Move
        )
    {
        return RecoveryDisposition::NeedsReview;
    }
    let source = &request.sources[0];
    let Some(destination) = request.destination.as_ref() else {
        return RecoveryDisposition::NeedsReview;
    };
    let Some(name) = source.file_name() else {
        return RecoveryDisposition::NeedsReview;
    };
    let target = destination.join(name);
    let Ok(source_exists) = source.try_exists() else {
        return RecoveryDisposition::NeedsReview;
    };
    let Ok(target_exists) = target.try_exists() else {
        return RecoveryDisposition::NeedsReview;
    };
    match (request.kind, source_exists, target_exists) {
        (FileOperationKind::Copy | FileOperationKind::Move, true, false) => {
            RecoveryDisposition::SafeToRetry
        }
        (FileOperationKind::Move, false, true) => RecoveryDisposition::CompletedMove,
        _ => RecoveryDisposition::NeedsReview,
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "journal path has no parent"))?;
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

    let temp = temp
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            temp.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        kind: FileOperationKind,
        source: PathBuf,
        destination: PathBuf,
    ) -> FileOperationRequest {
        FileOperationRequest {
            kind,
            sources: vec![source],
            destination: Some(destination),
            conflict_policy: ConflictPolicy::Error,
        }
    }

    #[test]
    fn journal_is_atomic_per_source_and_removed_when_empty() {
        let root =
            std::env::temp_dir().join(format!("explorie-operation-journal-{}", Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&destination).unwrap();
        let (store, interrupted, warning) = OperationRecoveryStore::open(&root);
        assert!(warning.is_none());
        assert!(interrupted.is_empty());
        let store = store.unwrap();
        let mut operation = request(FileOperationKind::Copy, source.join("first"), destination);
        operation.sources.push(source.join("second"));
        let ids = store.record(&operation).unwrap();
        assert_eq!(ids.len(), 2);

        let (_, reopened, warning) = OperationRecoveryStore::open(&root);
        assert!(warning.is_none());
        assert_eq!(reopened.len(), 2);
        assert!(
            reopened
                .iter()
                .all(|entry| entry.request.sources.len() == 1)
        );

        store.remove(&ids[..1]).unwrap();
        let (_, reopened, _) = OperationRecoveryStore::open(&root);
        assert_eq!(reopened.len(), 1);
        store.remove(&ids[1..]).unwrap();
        assert!(!root.join(JOURNAL_FILE).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_classification_is_conservative() {
        let root =
            std::env::temp_dir().join(format!("explorie-operation-reconcile-{}", Uuid::new_v4()));
        let source_dir = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&destination).unwrap();
        let source = source_dir.join("item.txt");
        fs::write(&source, b"source").unwrap();

        let disposable = destination.join(format!(".explorie-copy-{}", Uuid::new_v4()));
        let unrelated = destination.join(".explorie-copy-not-a-uuid");
        fs::create_dir(&disposable).unwrap();
        fs::create_dir(&unrelated).unwrap();

        let entry = JournalEntry {
            id: Uuid::new_v4().to_string(),
            request: request(FileOperationKind::Copy, source.clone(), destination.clone()),
        };
        let interrupted = classify_entry(&entry);
        assert_eq!(interrupted.disposition(), RecoveryDisposition::SafeToRetry);
        interrupted.prepare_retry().unwrap();
        assert!(!disposable.exists());
        assert!(unrelated.exists());

        assert_eq!(
            classify_request(&request(
                FileOperationKind::Copy,
                source.clone(),
                destination.clone()
            )),
            RecoveryDisposition::SafeToRetry
        );
        fs::write(destination.join("item.txt"), b"target").unwrap();
        assert_eq!(
            classify_request(&request(
                FileOperationKind::Copy,
                source.clone(),
                destination.clone()
            )),
            RecoveryDisposition::NeedsReview
        );
        fs::remove_file(&source).unwrap();
        assert_eq!(
            classify_request(&request(
                FileOperationKind::Move,
                source.clone(),
                destination.clone()
            )),
            RecoveryDisposition::CompletedMove
        );

        let mut renamed = request(FileOperationKind::Move, source, destination);
        renamed.conflict_policy = ConflictPolicy::Rename;
        assert_eq!(classify_request(&renamed), RecoveryDisposition::NeedsReview);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_journal_is_preserved_and_disables_writes() {
        let root =
            std::env::temp_dir().join(format!("explorie-operation-corrupt-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let journal = root.join(JOURNAL_FILE);
        fs::write(&journal, b"not json").unwrap();
        let (store, interrupted, warning) = OperationRecoveryStore::open(&root);
        assert!(store.is_none());
        assert!(interrupted.is_empty());
        assert!(warning.is_some());
        assert_eq!(fs::read(&journal).unwrap(), b"not json");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn destructive_operations_are_never_journaled() {
        let root =
            std::env::temp_dir().join(format!("explorie-operation-trash-{}", Uuid::new_v4()));
        let (store, _, _) = OperationRecoveryStore::open(&root);
        let store = store.unwrap();
        let trash = FileOperationRequest {
            kind: FileOperationKind::Trash,
            sources: vec![root.join("item")],
            destination: None,
            conflict_policy: ConflictPolicy::Error,
        };
        assert!(store.record(&trash).unwrap().is_empty());
        assert!(!root.join(JOURNAL_FILE).exists());
    }
}
