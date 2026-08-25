use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use explorie_native_services::{
    FileOperationEvent, FileOperationProgress, FileOperationRequest, FileOperationResult,
    FileOperationState,
};

const OPERATION_HISTORY_LIMIT: usize = 50;
const UNDO_HISTORY_LIMIT: usize = 50;
const UNDO_HISTORY_BYTES: usize = 24 * 1024 * 1024;
pub const UNDO_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationStatus {
    Running,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug)]
pub struct OperationRecord {
    id: String,
    request: FileOperationRequest,
    status: OperationStatus,
    progress: Option<FileOperationProgress>,
    result: Option<FileOperationResult>,
    retryable_sources: Vec<PathBuf>,
    error: Option<String>,
    undo_recorded: bool,
}

impl OperationRecord {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn request(&self) -> &FileOperationRequest {
        &self.request
    }

    pub fn status(&self) -> OperationStatus {
        self.status
    }

    pub fn progress(&self) -> Option<&FileOperationProgress> {
        self.progress.as_ref()
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn retryable_count(&self) -> usize {
        self.retryable_sources.len()
    }
}

#[derive(Debug, Default)]
pub struct OperationQueue {
    operations: Vec<OperationRecord>,
}

impl OperationQueue {
    pub fn track(&mut self, id: String, request: FileOperationRequest) {
        self.operations.retain(|operation| operation.id != id);
        self.operations.push(OperationRecord {
            id,
            request,
            status: OperationStatus::Running,
            progress: None,
            result: None,
            retryable_sources: Vec::new(),
            error: None,
            undo_recorded: false,
        });
        while self.operations.len() > OPERATION_HISTORY_LIMIT {
            let Some(index) = self
                .operations
                .iter()
                .position(|operation| operation.status != OperationStatus::Running)
            else {
                break;
            };
            self.operations.remove(index);
        }
    }

    pub fn apply(&mut self, event: FileOperationEvent) -> bool {
        let Some(operation) = self
            .operations
            .iter_mut()
            .find(|operation| operation.id == event.job_id)
        else {
            return false;
        };
        if let Some(progress) = event.progress {
            operation.progress = Some(progress);
        }
        operation.status = match event.state {
            FileOperationState::Running => OperationStatus::Running,
            FileOperationState::Completed => OperationStatus::Completed,
            FileOperationState::Cancelled => OperationStatus::Cancelled,
            FileOperationState::Failed => OperationStatus::Failed,
        };
        operation.result = event.result;
        operation.retryable_sources = event.retryable_sources;
        operation.error = event.error.map(|error| error.to_string());
        true
    }

    pub fn operations(&self) -> &[OperationRecord] {
        &self.operations
    }

    #[cfg(test)]
    pub fn latest(&self) -> Option<&OperationRecord> {
        self.operations.last()
    }

    pub fn latest_running_id(&self) -> Option<&str> {
        self.operations
            .iter()
            .rev()
            .find(|operation| operation.status == OperationStatus::Running)
            .map(OperationRecord::id)
    }

    pub fn active_count(&self) -> usize {
        self.operations
            .iter()
            .filter(|operation| operation.status == OperationStatus::Running)
            .count()
    }

    pub fn latest_retryable_id(&self) -> Option<&str> {
        self.operations
            .iter()
            .rev()
            .find(|operation| {
                !operation.retryable_sources.is_empty()
                    && operation.request.kind != explorie_native_services::FileOperationKind::Trash
            })
            .map(OperationRecord::id)
    }

    pub fn retry_request(&self, id: &str) -> Option<FileOperationRequest> {
        let operation = self
            .operations
            .iter()
            .find(|operation| operation.id == id)?;
        if operation.retryable_sources.is_empty()
            || operation.request.kind == explorie_native_services::FileOperationKind::Trash
        {
            return None;
        }
        let mut request = operation.request.clone();
        request.sources = operation.retryable_sources.clone();
        Some(request)
    }

    pub fn retryable_count(&self, id: &str) -> usize {
        self.operations
            .iter()
            .find(|operation| operation.id == id)
            .map_or(0, |operation| operation.retryable_sources.len())
    }

    pub fn mark_retry_started(&mut self, id: &str) {
        if let Some(operation) = self
            .operations
            .iter_mut()
            .find(|operation| operation.id == id)
        {
            operation.retryable_sources.clear();
        }
    }

    pub fn clear_completed(&mut self) {
        self.operations
            .retain(|operation| operation.status == OperationStatus::Running);
    }

    pub fn remove_finished(&mut self, id: &str) -> bool {
        let Some(index) = self
            .operations
            .iter()
            .position(|operation| operation.id == id)
        else {
            return false;
        };
        if self.operations[index].status == OperationStatus::Running {
            return false;
        }
        self.operations.remove(index);
        true
    }

    pub fn take_undo_record(&mut self, id: &str) -> Option<UndoRecord> {
        let operation = self
            .operations
            .iter_mut()
            .find(|operation| operation.id == id)?;
        if operation.undo_recorded || operation.status == OperationStatus::Running {
            return None;
        }
        operation.undo_recorded = true;
        let result = operation.result.as_ref()?.clone();
        if result.targets.is_empty() {
            return None;
        }
        let mut request = operation.request.clone();
        request.sources.truncate(result.targets.len());
        UndoRecord::from_file_operation(request, result)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClipboardKind {
    Copy,
    Cut,
}

#[derive(Clone, Debug)]
pub struct ClipboardState {
    pub kind: ClipboardKind,
    pub paths: Vec<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CreatedKind {
    Folder,
    Note,
    WebsiteLink { url: String },
}

#[derive(Clone, Debug)]
pub enum UndoAction {
    Copy {
        request: FileOperationRequest,
        targets: Vec<PathBuf>,
    },
    Move {
        request: FileOperationRequest,
        pairs: Vec<(PathBuf, PathBuf)>,
    },
    Create {
        kind: CreatedKind,
        path: PathBuf,
    },
    Rename {
        before: PathBuf,
        after: PathBuf,
    },
    BatchRename {
        pairs: Vec<(PathBuf, PathBuf)>,
    },
}

#[derive(Clone, Debug)]
pub struct UndoRecord {
    description: String,
    created_at: SystemTime,
    bytes: usize,
    pub action: UndoAction,
}

impl UndoRecord {
    pub fn from_file_operation(
        request: FileOperationRequest,
        result: FileOperationResult,
    ) -> Option<Self> {
        if request.conflict_policy == explorie_native_services::ConflictPolicy::Replace {
            return None;
        }
        let count = request.sources.len();
        let (description, action) = match request.kind {
            explorie_native_services::FileOperationKind::Copy if !result.targets.is_empty() => (
                format!("Copy {count} item(s)"),
                UndoAction::Copy {
                    request,
                    targets: result.targets,
                },
            ),
            explorie_native_services::FileOperationKind::Move
                if result.targets.len() == request.sources.len() =>
            {
                let pairs = request
                    .sources
                    .iter()
                    .cloned()
                    .zip(result.targets)
                    .collect();
                (
                    format!("Move {count} item(s)"),
                    UndoAction::Move { request, pairs },
                )
            }
            explorie_native_services::FileOperationKind::Copy
            | explorie_native_services::FileOperationKind::Move
            | explorie_native_services::FileOperationKind::Trash => return None,
        };
        Some(Self::new(description, action))
    }

    pub fn created(kind: CreatedKind, path: PathBuf) -> Self {
        let label = match &kind {
            CreatedKind::Folder => "folder",
            CreatedKind::Note => "note",
            CreatedKind::WebsiteLink { .. } => "website link",
        };
        Self::new(format!("Create {label}"), UndoAction::Create { kind, path })
    }

    pub fn renamed(before: PathBuf, after: PathBuf) -> Self {
        Self::new(
            "Rename item".to_string(),
            UndoAction::Rename { before, after },
        )
    }

    pub fn batch_renamed(pairs: Vec<(PathBuf, PathBuf)>) -> Self {
        let count = pairs.len();
        Self::new(
            format!("Rename {count} items"),
            UndoAction::BatchRename { pairs },
        )
    }

    fn new(description: String, action: UndoAction) -> Self {
        let bytes = description.len() + action_path_bytes(&action);
        Self {
            description,
            created_at: SystemTime::now(),
            bytes,
            action,
        }
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    fn expired_at(&self, now: SystemTime, timeout: Duration) -> bool {
        now.duration_since(self.created_at)
            .is_ok_and(|elapsed| elapsed >= timeout)
    }
}

#[derive(Debug)]
pub struct UndoLedger {
    undo: Vec<UndoRecord>,
    redo: Vec<UndoRecord>,
    processing: bool,
    timeout: Duration,
}

impl Default for UndoLedger {
    fn default() -> Self {
        Self::with_timeout(UNDO_TIMEOUT)
    }
}

impl UndoLedger {
    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            undo: Vec::new(),
            redo: Vec::new(),
            processing: false,
            timeout,
        }
    }

    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    pub fn push(&mut self, record: UndoRecord) {
        self.undo.push(record);
        self.redo.clear();
        trim_undo_stack(&mut self.undo);
    }

    pub fn can_undo(&self, now: SystemTime) -> bool {
        !self.processing
            && self
                .undo
                .last()
                .is_some_and(|record| !record.expired_at(now, self.timeout))
    }

    pub fn can_redo(&self) -> bool {
        !self.processing && !self.redo.is_empty()
    }

    pub fn is_processing(&self) -> bool {
        self.processing
    }

    pub fn begin_undo(&mut self, now: SystemTime) -> Option<UndoRecord> {
        self.prune_expired(now);
        if self.processing {
            return None;
        }
        let record = self.undo.pop()?;
        self.processing = true;
        Some(record)
    }

    pub fn begin_redo(&mut self) -> Option<UndoRecord> {
        if self.processing {
            return None;
        }
        let record = self.redo.pop()?;
        self.processing = true;
        Some(record)
    }

    pub fn finish_undo(&mut self, record: UndoRecord, succeeded: bool) {
        self.processing = false;
        if succeeded {
            self.redo.push(record);
            trim_undo_stack(&mut self.redo);
        } else {
            self.undo.push(record);
            trim_undo_stack(&mut self.undo);
        }
    }

    pub fn finish_redo(&mut self, record: UndoRecord, succeeded: bool) {
        self.processing = false;
        if succeeded {
            self.undo.push(record);
            trim_undo_stack(&mut self.undo);
        } else {
            self.redo.push(record);
            trim_undo_stack(&mut self.redo);
        }
    }

    pub fn prune_expired(&mut self, now: SystemTime) {
        self.undo
            .retain(|record| !record.expired_at(now, self.timeout));
    }
}

fn action_path_bytes(action: &UndoAction) -> usize {
    let path_bytes = |path: &PathBuf| path.as_os_str().to_string_lossy().len();
    match action {
        UndoAction::Copy { request, targets } => {
            request.sources.iter().map(&path_bytes).sum::<usize>()
                + request.destination.as_ref().map_or(0, &path_bytes)
                + targets.iter().map(path_bytes).sum::<usize>()
        }
        UndoAction::Move { request, pairs } => {
            request.sources.iter().map(&path_bytes).sum::<usize>()
                + request.destination.as_ref().map_or(0, &path_bytes)
                + pairs
                    .iter()
                    .map(|(source, target)| path_bytes(source) + path_bytes(target))
                    .sum::<usize>()
        }
        UndoAction::Create { kind, path } => {
            path_bytes(path)
                + match kind {
                    CreatedKind::WebsiteLink { url } => url.len(),
                    CreatedKind::Folder | CreatedKind::Note => 0,
                }
        }
        UndoAction::Rename { before, after } => path_bytes(before) + path_bytes(after),
        UndoAction::BatchRename { pairs } => pairs
            .iter()
            .map(|(before, after)| path_bytes(before) + path_bytes(after))
            .sum(),
    }
}

fn trim_undo_stack(stack: &mut Vec<UndoRecord>) {
    while stack.len() > UNDO_HISTORY_LIMIT {
        stack.remove(0);
    }
    let mut bytes = stack.iter().map(|record| record.bytes).sum::<usize>();
    while bytes > UNDO_HISTORY_BYTES && !stack.is_empty() {
        bytes = bytes.saturating_sub(stack.remove(0).bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use explorie_native_services::{ConflictPolicy, ErrorCode, FileOperationKind, ServiceError};

    fn request() -> FileOperationRequest {
        FileOperationRequest {
            kind: FileOperationKind::Copy,
            sources: vec![PathBuf::from("source")],
            destination: Some(PathBuf::from("destination")),
            conflict_policy: ConflictPolicy::Rename,
        }
    }

    #[test]
    fn queue_tracks_aggregate_progress_completion_and_unknown_events() {
        let mut queue = OperationQueue::default();
        queue.track("job".into(), request());
        assert_eq!(queue.active_count(), 1);
        assert!(queue.apply(FileOperationEvent {
            job_id: "job".into(),
            state: FileOperationState::Running,
            progress: Some(FileOperationProgress {
                processed_entries: 2,
                total_entries: 4,
                processed_bytes: 10,
                total_bytes: 20,
                current_path: Some(PathBuf::from("source")),
            }),
            result: None,
            retryable_sources: Vec::new(),
            error: None,
        }));
        assert_eq!(
            queue.operations()[0].progress().unwrap().processed_bytes,
            10
        );
        assert!(queue.apply(FileOperationEvent {
            job_id: "job".into(),
            state: FileOperationState::Completed,
            progress: None,
            result: Some(FileOperationResult {
                processed_entries: 4,
                processed_bytes: 20,
                targets: vec![PathBuf::from("destination/source")],
            }),
            retryable_sources: Vec::new(),
            error: None,
        }));
        assert_eq!(queue.active_count(), 0);
        assert_eq!(queue.operations()[0].status(), OperationStatus::Completed);
        assert!(!queue.apply(FileOperationEvent {
            job_id: "unknown".into(),
            state: FileOperationState::Cancelled,
            progress: None,
            result: None,
            retryable_sources: Vec::new(),
            error: None,
        }));
    }

    #[test]
    fn completed_non_replacing_jobs_create_bounded_undo_records_once() {
        let mut queue = OperationQueue::default();
        queue.track("job".into(), request());
        assert!(queue.apply(FileOperationEvent {
            job_id: "job".into(),
            state: FileOperationState::Completed,
            progress: None,
            result: Some(FileOperationResult {
                processed_entries: 1,
                processed_bytes: 4,
                targets: vec![PathBuf::from("destination/source")],
            }),
            retryable_sources: Vec::new(),
            error: None,
        }));

        let record = queue.take_undo_record("job").expect("undo record");
        assert_eq!(record.description(), "Copy 1 item(s)");
        assert!(matches!(record.action, UndoAction::Copy { .. }));
        assert!(queue.take_undo_record("job").is_none());

        let mut replacing = request();
        replacing.conflict_policy = ConflictPolicy::Replace;
        assert!(
            UndoRecord::from_file_operation(
                replacing,
                FileOperationResult {
                    processed_entries: 1,
                    processed_bytes: 4,
                    targets: vec![PathBuf::from("destination/source")],
                },
            )
            .is_none()
        );
    }

    #[test]
    fn undo_ledger_expires_records_and_clears_redo_on_new_mutation() {
        let now = SystemTime::now();
        let mut ledger = UndoLedger::default();
        let first = UndoRecord::created(CreatedKind::Folder, PathBuf::from("first"));
        ledger.push(first);
        let undone = ledger.begin_undo(now).expect("undoable record");
        ledger.finish_undo(undone, true);
        assert!(ledger.can_redo());

        ledger.push(UndoRecord::created(
            CreatedKind::Note,
            PathBuf::from("second.md"),
        ));
        assert!(!ledger.can_redo());
        ledger.undo.last_mut().unwrap().created_at = now - UNDO_TIMEOUT;
        assert!(!ledger.can_undo(now));
        assert!(ledger.begin_undo(now).is_none());
    }

    #[test]
    fn failed_undo_and_redo_return_records_to_their_original_stack() {
        let now = SystemTime::now();
        let mut ledger = UndoLedger::default();
        ledger.push(UndoRecord::renamed(
            PathBuf::from("before"),
            PathBuf::from("after"),
        ));
        let undo = ledger.begin_undo(now).unwrap();
        ledger.finish_undo(undo, false);
        assert!(ledger.can_undo(now));

        let undo = ledger.begin_undo(now).unwrap();
        ledger.finish_undo(undo, true);
        let redo = ledger.begin_redo().unwrap();
        ledger.finish_redo(redo, false);
        assert!(ledger.can_redo());
    }

    #[test]
    fn history_limit_never_discards_a_running_job() {
        let mut queue = OperationQueue::default();
        for index in 0..=OPERATION_HISTORY_LIMIT {
            queue.track(format!("job-{index}"), request());
        }
        assert_eq!(queue.operations().len(), OPERATION_HISTORY_LIMIT + 1);
        assert_eq!(queue.active_count(), OPERATION_HISTORY_LIMIT + 1);

        assert!(queue.apply(FileOperationEvent {
            job_id: "job-0".into(),
            state: FileOperationState::Completed,
            progress: None,
            result: Some(FileOperationResult {
                processed_entries: 1,
                processed_bytes: 1,
                targets: vec![PathBuf::from("destination/source")],
            }),
            retryable_sources: Vec::new(),
            error: None,
        }));
        queue.track("job-next".into(), request());
        assert_eq!(queue.operations().len(), OPERATION_HISTORY_LIMIT + 1);
        assert!(
            queue
                .operations()
                .iter()
                .all(|operation| operation.id() != "job-0")
        );
        assert_eq!(queue.active_count(), OPERATION_HISTORY_LIMIT + 1);
    }

    #[test]
    fn partial_failures_retry_only_unresolved_sources_and_keep_completed_undo() {
        let mut batch = request();
        batch.sources = vec![PathBuf::from("first"), PathBuf::from("second")];
        let mut queue = OperationQueue::default();
        queue.track("batch".into(), batch);
        assert!(queue.apply(FileOperationEvent {
            job_id: "batch".into(),
            state: FileOperationState::Failed,
            progress: None,
            result: Some(FileOperationResult {
                processed_entries: 1,
                processed_bytes: 5,
                targets: vec![PathBuf::from("destination/first")],
            }),
            retryable_sources: vec![PathBuf::from("second")],
            error: Some(ServiceError::new(ErrorCode::Conflict, "destination exists")),
        }));

        let retry = queue.retry_request("batch").expect("retry request");
        assert_eq!(retry.sources, vec![PathBuf::from("second")]);
        let undo = queue
            .take_undo_record("batch")
            .expect("completed prefix undo");
        match undo.action {
            UndoAction::Copy { request, targets } => {
                assert_eq!(request.sources, vec![PathBuf::from("first")]);
                assert_eq!(targets, vec![PathBuf::from("destination/first")]);
            }
            other => panic!("unexpected undo action: {other:?}"),
        }
        queue.mark_retry_started("batch");
        assert!(queue.retry_request("batch").is_none());
    }

    #[test]
    fn trash_is_never_retryable_even_if_a_misbehaving_host_marks_a_source() {
        let mut trash = request();
        trash.kind = FileOperationKind::Trash;
        trash.destination = None;
        let mut queue = OperationQueue::default();
        queue.track("trash".into(), trash);
        assert!(queue.apply(FileOperationEvent {
            job_id: "trash".into(),
            state: FileOperationState::Failed,
            progress: None,
            result: Some(FileOperationResult {
                processed_entries: 0,
                processed_bytes: 0,
                targets: Vec::new(),
            }),
            retryable_sources: vec![PathBuf::from("source")],
            error: Some(ServiceError::new(ErrorCode::Io, "trash failed")),
        }));
        assert!(queue.retry_request("trash").is_none());
    }
}
