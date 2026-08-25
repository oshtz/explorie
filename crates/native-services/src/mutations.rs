use crate::listing::normalize_path;
use crate::{
    ActiveOperation, BlockingTask, ErrorCode, FileOperationEvent, FileOperationState,
    ServiceContext, ServiceError, ServiceEvent, ServiceResult, SharedState,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

/// Typed requests for the small, user-initiated mutations that do not need a
/// long-running operation queue entry.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SafeMutationRequest {
    Rename {
        source_path: PathBuf,
        new_base_name: String,
    },
    CreateFolder {
        dir_path: PathBuf,
        base_name: String,
    },
    CreateNote {
        dir_path: PathBuf,
        base_name: String,
    },
    CreateWebsiteLink {
        dir_path: PathBuf,
        base_name: String,
        url: String,
    },
    DeletePermanently {
        path: PathBuf,
        recursive: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermanentDeleteFailure {
    pub path: PathBuf,
    pub error: ServiceError,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermanentDeleteResult {
    pub requested_items: usize,
    pub deleted_items: usize,
    pub failure: Option<PermanentDeleteFailure>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameItem {
    pub source_path: PathBuf,
    pub new_base_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenamePair {
    pub before: PathBuf,
    pub after: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameResult {
    pub renamed: Vec<BatchRenamePair>,
}

#[derive(Clone)]
pub struct MutationService {
    context: ServiceContext,
    shared: Arc<SharedState>,
}

impl MutationService {
    pub(crate) fn new(context: ServiceContext, shared: Arc<SharedState>) -> Self {
        Self { context, shared }
    }

    pub fn start_file_operation(
        &self,
        request: explorie_core::FileOperationRequest,
    ) -> ServiceResult<String> {
        if request
            .sources
            .iter()
            .any(|source| self.is_remote_root(source))
            || request
                .destination
                .as_deref()
                .is_some_and(|destination| self.is_remote_root(destination))
        {
            return Err(ServiceError::new(
                ErrorCode::RemoteUnavailable,
                "Refusing to mutate a managed remote-drive root",
            ));
        }

        let job_id = format!(
            "{}-{}",
            std::process::id(),
            self.shared.next_job_id.fetch_add(1, Ordering::Relaxed)
        );
        let cancelled = Arc::new(AtomicBool::new(false));
        self.shared
            .cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(job_id.clone(), Arc::clone(&cancelled));
        let guard = ActiveOperation::new(Arc::clone(&self.shared));
        let shared = Arc::clone(&self.shared);
        let events = self.context.events();
        let task_job_id = job_id.clone();
        std::thread::spawn(move || {
            let request_sources = request.sources.clone();
            let operation_kind = request.kind;
            let operation =
                explorie_core::perform_file_operation_report(request, &cancelled, |progress| {
                    events.publish(ServiceEvent::FileOperation(FileOperationEvent {
                        job_id: task_job_id.clone(),
                        state: FileOperationState::Running,
                        progress: Some(progress),
                        result: None,
                        retryable_sources: Vec::new(),
                        error: None,
                    }));
                });

            let event = match operation {
                Ok(result) => FileOperationEvent {
                    job_id: task_job_id.clone(),
                    state: FileOperationState::Completed,
                    progress: None,
                    result: Some(result),
                    retryable_sources: Vec::new(),
                    error: None,
                },
                Err(failure) => {
                    let retryable_sources =
                        if operation_kind == explorie_core::FileOperationKind::Trash {
                            Vec::new()
                        } else {
                            let completed = failure
                                .partial_result
                                .targets
                                .len()
                                .min(request_sources.len());
                            request_sources[completed..].to_vec()
                        };
                    if failure.error.kind() == io::ErrorKind::Interrupted {
                        FileOperationEvent {
                            job_id: task_job_id.clone(),
                            state: FileOperationState::Cancelled,
                            progress: None,
                            result: Some(failure.partial_result),
                            retryable_sources,
                            error: None,
                        }
                    } else {
                        FileOperationEvent {
                            job_id: task_job_id.clone(),
                            state: FileOperationState::Failed,
                            progress: None,
                            result: Some(failure.partial_result),
                            retryable_sources,
                            error: Some(ServiceError::from(failure.error)),
                        }
                    }
                }
            };
            remove_job(&shared, &task_job_id);
            events.publish(ServiceEvent::FileOperation(event));
            drop(guard);
        });

        Ok(job_id)
    }

    pub fn cancel_file_operation(&self, job_id: &str) -> bool {
        let cancellations = self
            .shared
            .cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cancelled) = cancellations.get(job_id) {
            cancelled.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }

    pub fn cancel_all(&self) {
        for cancelled in self
            .shared
            .cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
        {
            cancelled.store(true, Ordering::Relaxed);
        }
    }

    pub fn active_count(&self) -> u64 {
        self.shared.active_mutations.load(Ordering::Acquire)
    }

    /// Mark an exit attempt. The host should prevent exit and call
    /// [`cancel_all`](Self::cancel_all) while this returns `true`.
    pub fn request_exit(&self) -> bool {
        let active = self.active_count() > 0;
        self.shared.exit_requested.store(active, Ordering::Release);
        active
    }

    pub fn rename_path(&self, source_path: PathBuf, new_base_name: String) -> BlockingTask<String> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &source_path) {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to rename a managed remote-drive root",
                ));
            }
            let _guard = guard;
            rename_path_impl(&source_path, &new_base_name).map_err(ServiceError::from)
        })
    }

    pub fn batch_rename(&self, items: Vec<BatchRenameItem>) -> BlockingTask<BatchRenameResult> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            let _guard = guard;
            batch_rename_impl(&shared, items).map_err(ServiceError::from)
        })
    }

    pub fn create_folder(&self, dir_path: PathBuf, base_name: String) -> BlockingTask<String> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &dir_path) {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to mutate a managed remote-drive root",
                ));
            }
            let _guard = guard;
            create_folder_impl(&dir_path, &base_name).map_err(ServiceError::from)
        })
    }

    pub fn create_note(&self, dir_path: PathBuf, base_name: String) -> BlockingTask<String> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &dir_path) {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to mutate a managed remote-drive root",
                ));
            }
            let _guard = guard;
            create_note_impl(&dir_path, &base_name).map_err(ServiceError::from)
        })
    }

    pub fn create_website_link(
        &self,
        dir_path: PathBuf,
        base_name: String,
        url: String,
    ) -> BlockingTask<String> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &dir_path) {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to mutate a managed remote-drive root",
                ));
            }
            let _guard = guard;
            create_website_link_impl(&dir_path, &base_name, &url).map_err(ServiceError::from)
        })
    }

    pub fn delete_permanently(&self, path: PathBuf, recursive: bool) -> BlockingTask<()> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            if remote_root(&shared, &path) {
                return Err(ServiceError::new(
                    ErrorCode::RemoteUnavailable,
                    "Refusing to delete a managed remote-drive root",
                ));
            }
            let _guard = guard;
            delete_path_permanently_impl(&path, recursive).map_err(ServiceError::from)
        })
    }

    pub fn delete_permanently_batch(
        &self,
        items: Vec<(PathBuf, bool)>,
    ) -> BlockingTask<PermanentDeleteResult> {
        let shared = Arc::clone(&self.shared);
        let guard = ActiveOperation::new(Arc::clone(&shared));
        self.context.spawn_blocking(move || {
            let requested_items = items.len();
            let _guard = guard;
            let mut deleted_items = 0;
            for (path, recursive) in items {
                let result = if remote_root(&shared, &path) {
                    Err(ServiceError::new(
                        ErrorCode::RemoteUnavailable,
                        "Refusing to delete a managed remote-drive root",
                    ))
                } else {
                    delete_path_permanently_impl(&path, recursive).map_err(ServiceError::from)
                };
                if let Err(error) = result {
                    return Ok(PermanentDeleteResult {
                        requested_items,
                        deleted_items,
                        failure: Some(PermanentDeleteFailure { path, error }),
                    });
                }
                deleted_items += 1;
            }
            Ok(PermanentDeleteResult {
                requested_items,
                deleted_items,
                failure: None,
            })
        })
    }

    pub fn path_exists(&self, path: PathBuf) -> BlockingTask<bool> {
        self.context
            .spawn_blocking(move || path.try_exists().map_err(ServiceError::from))
    }

    pub fn run_safe(&self, request: SafeMutationRequest) -> BlockingTask<String> {
        match request {
            SafeMutationRequest::Rename {
                source_path,
                new_base_name,
            } => self.rename_path(source_path, new_base_name),
            SafeMutationRequest::CreateFolder {
                dir_path,
                base_name,
            } => self.create_folder(dir_path, base_name),
            SafeMutationRequest::CreateNote {
                dir_path,
                base_name,
            } => self.create_note(dir_path, base_name),
            SafeMutationRequest::CreateWebsiteLink {
                dir_path,
                base_name,
                url,
            } => self.create_website_link(dir_path, base_name, url),
            SafeMutationRequest::DeletePermanently { path, recursive } => {
                let task = self.delete_permanently(path, recursive);
                self.context
                    .spawn_blocking(move || task.wait().map(|()| String::new()))
            }
        }
    }

    fn is_remote_root(&self, path: &Path) -> bool {
        remote_root(&self.shared, path)
    }
}

fn remote_root(shared: &SharedState, path: &Path) -> bool {
    shared
        .remote_roots
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(&normalize_path(path))
}

fn validate_file_name(name: &str) -> io::Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "File name cannot be empty",
        ));
    }
    if name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "File name cannot contain path separators or be . or ..",
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "File name cannot contain control characters",
        ));
    }
    #[cfg(windows)]
    {
        if name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.ends_with(['.', ' ']) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "File name is invalid on Windows",
            ));
        }
        let base = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || base
                .strip_prefix("COM")
                .or_else(|| base.strip_prefix("LPT"))
                .is_some_and(|number| {
                    matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                })
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "File name is reserved on Windows",
            ));
        }
    }
    Ok(name.to_string())
}

fn ensure_extension(name: &str, extension: &str) -> String {
    if name
        .to_ascii_lowercase()
        .ends_with(&extension.to_ascii_lowercase())
    {
        name.to_string()
    } else {
        format!("{name}{extension}")
    }
}

fn metadata_is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn validate_no_link_ancestors(path: &Path) -> io::Result<()> {
    let mut ancestors: Vec<&Path> = path.ancestors().collect();
    ancestors.reverse();
    for ancestor in ancestors {
        let metadata = fs::symlink_metadata(ancestor)?;
        if metadata_is_link(&metadata) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "Refusing to traverse a symbolic link or junction: {}",
                    ancestor.display()
                ),
            ));
        }
    }
    Ok(())
}

fn validate_real_directory(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Directory path must be absolute",
        ));
    }
    validate_no_link_ancestors(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata_is_link(&metadata) || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Destination must be a real directory",
        ));
    }
    Ok(())
}

fn mount_check_path(path: &Path, canonical: io::Result<PathBuf>) -> io::Result<PathBuf> {
    match canonical {
        Ok(path) => Ok(path),
        #[cfg(windows)]
        Err(error) if error.raw_os_error() == Some(1005) => Ok(path.to_path_buf()),
        Err(error) => Err(error),
    }
}

fn ensure_not_mount_root(path: &Path) -> io::Result<()> {
    let canonical = mount_check_path(path, fs::canonicalize(path))?;
    if canonical.parent().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Refusing to mutate a filesystem root",
        ));
    }
    let disks = sysinfo::Disks::new_with_refreshed_list();
    if disks.iter().any(|disk| {
        mount_check_path(disk.mount_point(), fs::canonicalize(disk.mount_point()))
            .is_ok_and(|mount| mount == canonical)
    }) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Refusing to mutate a mounted volume root",
        ));
    }
    Ok(())
}

fn suffixed_name(base_name: &str, number: u32, preserve_extension: bool) -> OsString {
    if number == 1 {
        return OsString::from(base_name);
    }
    if !preserve_extension {
        return OsString::from(format!("{base_name} ({number})"));
    }
    let path = Path::new(base_name);
    let stem = path.file_stem().unwrap_or(path.as_os_str());
    let mut name = OsString::from(stem);
    name.push(format!(" ({number})"));
    if let Some(extension) = path.extension() {
        name.push(".");
        name.push(extension);
    }
    name
}

fn create_unique_path(
    parent: &Path,
    base_name: &str,
    preserve_extension: bool,
    mut create: impl FnMut(&Path) -> io::Result<()>,
) -> io::Result<PathBuf> {
    for number in 1..=9_999 {
        let candidate = parent.join(suffixed_name(base_name, number, preserve_extension));
        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        match create(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "Could not find a unique file name",
    ))
}

fn write_new_text_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(contents)?;
        file.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

fn rename_path_impl(source: &Path, new_base_name: &str) -> io::Result<String> {
    if !source.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Source path must be absolute",
        ));
    }
    let metadata = fs::symlink_metadata(source)?;
    if !metadata_is_link(&metadata) {
        ensure_not_mount_root(source)?;
    }
    if !metadata_is_link(&metadata) && !metadata.is_file() && !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Unsupported filesystem entry",
        ));
    }
    let parent = source.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Cannot rename a filesystem root",
        )
    })?;
    validate_real_directory(parent)?;
    let name = validate_file_name(new_base_name)?;
    let destination = create_unique_path(parent, &name, true, |candidate| {
        explorie_core::rename_noreplace(source, candidate)
    })?;
    Ok(destination.to_string_lossy().into_owned())
}

fn batch_rename_impl(
    shared: &SharedState,
    items: Vec<BatchRenameItem>,
) -> io::Result<BatchRenameResult> {
    if items.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Batch rename requires at least one changed item",
        ));
    }
    if items.len() > 10_000 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Batch rename is limited to 10,000 items",
        ));
    }

    let mut sources = HashSet::with_capacity(items.len());
    let mut targets = HashSet::with_capacity(items.len());
    let mut plan = Vec::with_capacity(items.len());
    for item in items {
        let source = item.source_path;
        if !source.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Batch rename source paths must be absolute",
            ));
        }
        if remote_root(shared, &source) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Refusing to rename a managed remote-drive root",
            ));
        }
        let metadata = fs::symlink_metadata(&source)?;
        if !metadata_is_link(&metadata) {
            ensure_not_mount_root(&source)?;
        }
        if !metadata_is_link(&metadata) && !metadata.is_file() && !metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Unsupported filesystem entry in batch rename",
            ));
        }
        let parent = source.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Cannot rename a filesystem root",
            )
        })?;
        validate_real_directory(parent)?;
        let name = validate_file_name(&item.new_base_name)?;
        let target = parent.join(name);
        let source_key = normalize_path(&source);
        let target_key = normalize_path(&target);
        if !sources.insert(source_key) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Batch rename source paths must be unique",
            ));
        }
        if !targets.insert(target_key) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "Batch rename would create duplicate names",
            ));
        }
        if source != target {
            plan.push((source, target));
        }
    }

    if plan.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Batch rename does not change any names",
        ));
    }

    for (_, target) in &plan {
        match fs::symlink_metadata(target) {
            Ok(_) if !sources.contains(&normalize_path(target)) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("Batch rename target already exists: {}", target.display()),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }

    let transaction = Uuid::new_v4().simple().to_string();
    let mut staged: Vec<(PathBuf, PathBuf, PathBuf)> = Vec::with_capacity(plan.len());
    for (index, (source, target)) in plan.iter().enumerate() {
        let parent = source.parent().expect("validated batch source parent");
        let temporary = parent.join(format!(".explorie-rename-{transaction}-{index}"));
        if let Err(error) = explorie_core::rename_noreplace(source, &temporary) {
            let rollback = rollback_staged(&staged);
            return Err(batch_rename_error("staging", error, rollback));
        }
        staged.push((source.clone(), temporary, target.clone()));
    }

    for (committed, (_, temporary, target)) in staged.iter().enumerate() {
        if let Err(error) = explorie_core::rename_noreplace(temporary, target) {
            let rollback = rollback_batch_commit(&staged, committed);
            return Err(batch_rename_error("commit", error, rollback));
        }
    }

    Ok(BatchRenameResult {
        renamed: staged
            .into_iter()
            .map(|(before, _, after)| BatchRenamePair { before, after })
            .collect(),
    })
}

fn rollback_staged(staged: &[(PathBuf, PathBuf, PathBuf)]) -> io::Result<()> {
    let mut first_error = None;
    for (source, temporary, _) in staged.iter().rev() {
        if let Err(error) = explorie_core::rename_noreplace(temporary, source)
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn rollback_batch_commit(
    staged: &[(PathBuf, PathBuf, PathBuf)],
    committed: usize,
) -> io::Result<()> {
    let mut first_error = None;
    for (source, _, target) in staged[..committed].iter().rev() {
        if let Err(error) = explorie_core::rename_noreplace(target, source)
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    for (source, temporary, _) in staged[committed..].iter().rev() {
        if let Err(error) = explorie_core::rename_noreplace(temporary, source)
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn batch_rename_error(stage: &str, error: io::Error, rollback: io::Result<()>) -> io::Error {
    match rollback {
        Ok(()) => io::Error::new(
            error.kind(),
            format!("Batch rename {stage} failed and was rolled back: {error}"),
        ),
        Err(rollback_error) => io::Error::other(format!(
            "Batch rename {stage} failed ({error}); rollback also failed ({rollback_error}). Manual recovery may be required for .explorie-rename-* entries."
        )),
    }
}

fn create_folder_impl(directory: &Path, base_name: &str) -> io::Result<String> {
    validate_real_directory(directory)?;
    let name = validate_file_name(base_name)?;
    let path = create_unique_path(directory, &name, false, |candidate| {
        fs::create_dir(candidate)
    })?;
    Ok(path.to_string_lossy().into_owned())
}

fn create_note_impl(directory: &Path, base_name: &str) -> io::Result<String> {
    validate_real_directory(directory)?;
    let name = validate_file_name(&ensure_extension(base_name, ".md"))?;
    let path = create_unique_path(directory, &name, true, |candidate| {
        write_new_text_file(candidate, b"# New Note\n")
    })?;
    Ok(path.to_string_lossy().into_owned())
}

fn create_website_link_impl(directory: &Path, base_name: &str, url: &str) -> io::Result<String> {
    validate_real_directory(directory)?;
    let name = validate_file_name(&ensure_extension(base_name, ".url"))?;
    let url = url.trim();
    if url.chars().any(char::is_control) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Website URL cannot contain control characters",
        ));
    }
    let normalized = url.to_ascii_lowercase();
    if !normalized.starts_with("https://") && !normalized.starts_with("http://") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Website URL must use http or https",
        ));
    }
    let contents = format!("[InternetShortcut]\nURL={url}\n");
    let path = create_unique_path(directory, &name, true, |candidate| {
        write_new_text_file(candidate, contents.as_bytes())
    })?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeleteEntryKind {
    File,
    Directory,
    Link,
}

fn delete_entry_kind(metadata: &fs::Metadata) -> io::Result<DeleteEntryKind> {
    if metadata_is_link(metadata) {
        Ok(DeleteEntryKind::Link)
    } else if metadata.is_file() {
        Ok(DeleteEntryKind::File)
    } else if metadata.is_dir() {
        Ok(DeleteEntryKind::Directory)
    } else {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "special filesystem entries cannot be permanently deleted",
        ))
    }
}

#[cfg(unix)]
fn same_device(root: &fs::Metadata, candidate: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    root.dev() == candidate.dev()
}

#[cfg(not(unix))]
fn same_device(_root: &fs::Metadata, _candidate: &fs::Metadata) -> bool {
    true
}

fn collect_delete_entries(
    path: &Path,
    root_metadata: &fs::Metadata,
    entries: &mut Vec<(PathBuf, DeleteEntryKind)>,
) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    let kind = delete_entry_kind(&metadata)?;
    if kind != DeleteEntryKind::Link && !same_device(root_metadata, &metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "refusing to cross a mounted filesystem at {}",
                path.display()
            ),
        ));
    }
    entries.push((path.to_path_buf(), kind));
    if kind == DeleteEntryKind::Directory {
        for child in fs::read_dir(path)? {
            collect_delete_entries(&child?.path(), root_metadata, entries)?;
        }
    }
    Ok(())
}

fn remove_link(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(file_error) => fs::remove_dir(path).map_err(|_| file_error),
    }
}

fn remove_planned_entry(path: &Path, expected: DeleteEntryKind) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    let actual = delete_entry_kind(&metadata)?;
    if actual != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "filesystem entry changed during deletion: {}",
                path.display()
            ),
        ));
    }
    match actual {
        DeleteEntryKind::File => fs::remove_file(path),
        DeleteEntryKind::Directory => fs::remove_dir(path),
        DeleteEntryKind::Link => remove_link(path),
    }
}

fn delete_path_permanently_impl(path: &Path, recursive: bool) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Delete path must be absolute",
        ));
    }
    if let Some(parent) = path.parent() {
        validate_no_link_ancestors(parent)?;
    }
    let root_metadata = fs::symlink_metadata(path)?;
    let root_kind = delete_entry_kind(&root_metadata)?;
    if root_kind != DeleteEntryKind::Link {
        ensure_not_mount_root(path)?;
    }
    if root_kind != DeleteEntryKind::Directory || !recursive {
        return remove_planned_entry(path, root_kind);
    }
    let mut entries = Vec::new();
    collect_delete_entries(path, &root_metadata, &mut entries)?;
    for (entry, kind) in entries.into_iter().rev() {
        remove_planned_entry(&entry, kind)?;
    }
    Ok(())
}

fn remove_job(shared: &SharedState, job_id: &str) {
    shared
        .cancellations
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(job_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NativeServices, ResourcePaths};
    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temporary directory")
    }

    #[test]
    fn safe_mutations_never_overwrite_and_validate_urls() {
        let temp = temp_dir();
        let root = temp.path().to_path_buf();
        fs::write(root.join("report.txt"), "existing").unwrap();
        fs::write(root.join("draft.txt"), "draft").unwrap();
        let services = NativeServices::new(ResourcePaths::test(&root));

        let renamed = services
            .mutations
            .rename_path(root.join("draft.txt"), "report.txt".into())
            .wait()
            .unwrap();
        assert_eq!(Path::new(&renamed).file_name().unwrap(), "report (2).txt");
        assert_eq!(
            fs::read_to_string(root.join("report.txt")).unwrap(),
            "existing"
        );

        let note = services
            .mutations
            .create_note(root.clone(), "Meeting Notes".into())
            .wait()
            .unwrap();
        assert_eq!(fs::read_to_string(note).unwrap(), "# New Note\n");
        assert!(
            services
                .mutations
                .path_exists(root.join("report.txt"))
                .wait()
                .unwrap()
        );
        assert!(
            !services
                .mutations
                .path_exists(root.join("missing.txt"))
                .wait()
                .unwrap()
        );
        assert!(
            services
                .mutations
                .create_website_link(root, "unsafe".into(), "javascript:alert(1)".into())
                .wait()
                .is_err()
        );
    }

    #[test]
    fn batch_rename_supports_swaps_without_overwriting() {
        let temp = temp_dir();
        let first = temp.path().join("first.txt");
        let second = temp.path().join("second.txt");
        fs::write(&first, "first contents").unwrap();
        fs::write(&second, "second contents").unwrap();
        let services = NativeServices::new(ResourcePaths::test(temp.path()));

        let result = services
            .mutations
            .batch_rename(vec![
                BatchRenameItem {
                    source_path: first.clone(),
                    new_base_name: "second.txt".to_string(),
                },
                BatchRenameItem {
                    source_path: second.clone(),
                    new_base_name: "first.txt".to_string(),
                },
            ])
            .wait()
            .unwrap();

        assert_eq!(result.renamed.len(), 2);
        assert_eq!(fs::read_to_string(first).unwrap(), "second contents");
        assert_eq!(fs::read_to_string(second).unwrap(), "first contents");
        assert_eq!(services.mutations.active_count(), 0);
        assert!(fs::read_dir(temp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".explorie-rename-")
        }));
    }

    #[test]
    fn batch_rename_rejects_external_conflicts_before_changing_any_source() {
        let temp = temp_dir();
        let first = temp.path().join("first.txt");
        let second = temp.path().join("second.txt");
        let occupied = temp.path().join("occupied.txt");
        fs::write(&first, "first contents").unwrap();
        fs::write(&second, "second contents").unwrap();
        fs::write(&occupied, "keep contents").unwrap();
        let services = NativeServices::new(ResourcePaths::test(temp.path()));

        let result = services
            .mutations
            .batch_rename(vec![
                BatchRenameItem {
                    source_path: first.clone(),
                    new_base_name: "renamed.txt".to_string(),
                },
                BatchRenameItem {
                    source_path: second.clone(),
                    new_base_name: "occupied.txt".to_string(),
                },
            ])
            .wait();

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(first).unwrap(), "first contents");
        assert_eq!(fs::read_to_string(second).unwrap(), "second contents");
        assert_eq!(fs::read_to_string(occupied).unwrap(), "keep contents");
    }

    #[test]
    fn batch_rename_commits_a_single_changed_item() {
        let temp = temp_dir();
        let source = temp.path().join("before.txt");
        let target = temp.path().join("after.txt");
        fs::write(&source, "contents").unwrap();
        let services = NativeServices::new(ResourcePaths::test(temp.path()));

        let result = services
            .mutations
            .batch_rename(vec![BatchRenameItem {
                source_path: source.clone(),
                new_base_name: "after.txt".to_string(),
            }])
            .wait()
            .unwrap();

        assert_eq!(result.renamed.len(), 1);
        assert!(!source.exists());
        assert_eq!(fs::read_to_string(target).unwrap(), "contents");
        assert_eq!(services.mutations.active_count(), 0);
    }

    #[test]
    fn exit_request_tracks_active_jobs_and_cancellation() {
        let root = temp_dir();
        let services = NativeServices::new(ResourcePaths::test(root.path()));
        let events = services.subscribe();
        let shared = Arc::clone(&services.mutations.shared);
        let guard = ActiveOperation::new(shared);
        assert_eq!(services.mutations.active_count(), 1);
        assert!(services.mutations.request_exit());
        services.mutations.cancel_all();
        drop(guard);
        assert_eq!(services.mutations.active_count(), 0);
        assert!(matches!(
            events
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap(),
            ServiceEvent::MutationIdle
        ));
    }

    #[test]
    fn permanent_delete_batch_reports_the_irreversible_completed_prefix() {
        let temp = temp_dir();
        let first = temp.path().join("first.txt");
        let missing = temp.path().join("missing.txt");
        fs::write(&first, "delete me").unwrap();
        let services = NativeServices::new(ResourcePaths::test(temp.path()));

        let result = services
            .mutations
            .delete_permanently_batch(vec![(first.clone(), false), (missing.clone(), false)])
            .wait()
            .unwrap();

        assert_eq!(result.requested_items, 2);
        assert_eq!(result.deleted_items, 1);
        assert_eq!(
            result.failure.as_ref().map(|failure| &failure.path),
            Some(&missing)
        );
        assert!(!first.exists());
        assert_eq!(services.mutations.active_count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn permanent_delete_unlinks_links_without_following_them() {
        use std::os::unix::fs::symlink;
        let temp = temp_dir();
        let outside = temp.path().join("outside");
        let source = temp.path().join("source");
        fs::create_dir(&outside).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(outside.join("keep.txt"), "keep").unwrap();
        symlink(&outside, source.join("link")).unwrap();
        let services = NativeServices::new(ResourcePaths::test(temp.path()));
        services
            .mutations
            .delete_permanently(source, true)
            .wait()
            .unwrap();
        assert_eq!(
            fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "keep"
        );
    }
}
