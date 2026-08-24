use super::is_link_metadata;
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
#[cfg(not(windows))]
use std::io::Write;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;
use uuid::Uuid;
use walkdir::WalkDir;

const COPY_BUFFER_SIZE: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileOperationKind {
    Copy,
    Move,
    Trash,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictPolicy {
    #[default]
    Error,
    Rename,
    Replace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationRequest {
    pub kind: FileOperationKind,
    pub sources: Vec<PathBuf>,
    pub destination: Option<PathBuf>,
    #[serde(default)]
    pub conflict_policy: ConflictPolicy,
    #[serde(default)]
    pub conflict_policies: Option<Vec<ConflictPolicy>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationProgress {
    pub processed_entries: u64,
    pub total_entries: u64,
    pub processed_bytes: u64,
    pub total_bytes: u64,
    pub current_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationResult {
    pub processed_entries: u64,
    pub processed_bytes: u64,
    pub targets: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlannedKind {
    Directory,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PlannedEntry {
    relative: PathBuf,
    kind: PlannedKind,
    len: u64,
    modified: Option<SystemTime>,
}

struct SourcePlan {
    source: PathBuf,
    canonical: PathBuf,
    entries: Vec<PlannedEntry>,
    total_bytes: u64,
}

struct ProgressTracker<'a, F: FnMut(FileOperationProgress)> {
    progress: FileOperationProgress,
    notify: &'a mut F,
}

impl<F: FnMut(FileOperationProgress)> ProgressTracker<'_, F> {
    fn emit(&mut self, current_path: Option<PathBuf>) {
        self.progress.current_path = current_path;
        (self.notify)(self.progress.clone());
    }

    fn copied_bytes(&mut self, path: &Path, bytes: u64) {
        self.progress.processed_bytes = self.progress.processed_bytes.saturating_add(bytes);
        self.emit(Some(path.to_path_buf()));
    }

    fn completed_entry(&mut self, path: &Path) {
        self.progress.processed_entries = self.progress.processed_entries.saturating_add(1);
        self.emit(Some(path.to_path_buf()));
    }
}

struct CommittedTarget {
    target: PathBuf,
    backup: Option<PathBuf>,
}

pub fn perform_file_operation(
    request: FileOperationRequest,
    cancelled: &AtomicBool,
    on_progress: impl FnMut(FileOperationProgress),
) -> io::Result<FileOperationResult> {
    perform_file_operation_with_cancel_gate(request, cancelled, on_progress, || {
        check_cancelled(cancelled)
    })
}

pub fn perform_file_operation_with_cancel_gate(
    request: FileOperationRequest,
    cancelled: &AtomicBool,
    mut on_progress: impl FnMut(FileOperationProgress),
    mut close_cancel_gate: impl FnMut() -> io::Result<()>,
) -> io::Result<FileOperationResult> {
    if request.sources.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "at least one source is required",
        ));
    }

    if request.kind == FileOperationKind::Trash {
        return trash_sources(request.sources, cancelled, on_progress);
    }

    let destination = request.destination.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "copy and move operations require a destination directory",
        )
    })?;
    let destination_metadata = fs::symlink_metadata(&destination)?;
    if is_link_metadata(&destination_metadata) || !destination_metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "destination must be a real directory",
        ));
    }
    let destination_canonical = fs::canonicalize(&destination)?;

    let plans: Vec<SourcePlan> = request
        .sources
        .iter()
        .map(|source| plan_source(source, cancelled))
        .collect::<io::Result<_>>()?;
    let conflict_policies = match request.conflict_policies {
        Some(policies) if policies.len() != plans.len() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "conflictPolicies must match the number of sources",
            ));
        }
        Some(policies) => policies,
        None => vec![request.conflict_policy; plans.len()],
    };
    validate_sources(&plans, &destination_canonical)?;

    let total_entries = plans.iter().map(|plan| plan.entries.len() as u64).sum();
    let total_bytes = plans.iter().map(|plan| plan.total_bytes).sum();
    let mut tracker = ProgressTracker {
        progress: FileOperationProgress {
            processed_entries: 0,
            total_entries,
            processed_bytes: 0,
            total_bytes,
            current_path: None,
        },
        notify: &mut on_progress,
    };
    tracker.emit(None);

    let mut targets = Vec::with_capacity(plans.len());
    for (plan, policy) in plans.iter().zip(&conflict_policies) {
        check_cancelled(cancelled)?;
        let file_name = plan.source.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "cannot operate on filesystem root {}",
                    plan.source.display()
                ),
            )
        })?;
        let requested_target = destination.join(file_name);
        let target = resolve_target(&requested_target, *policy, &targets)?;
        if same_path(&plan.canonical, &target)? {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "source and destination are the same path",
            ));
        }

        targets.push(target);
    }

    let mut stages = Vec::with_capacity(plans.len());
    let mut quarantines = Vec::with_capacity(plans.len());
    let mut cleanup_attempted = Vec::with_capacity(plans.len());
    let mut removed_quarantines = Vec::with_capacity(plans.len());
    let mut committed = Vec::with_capacity(plans.len());
    let operation = (|| {
        for (plan, target) in plans.iter().zip(&targets) {
            check_cancelled(cancelled)?;
            let purpose = if request.kind == FileOperationKind::Copy {
                "copy"
            } else {
                "move"
            };
            let stage = temporary_sibling(target, purpose);
            stages.push(stage.clone());
            copy_to_stage(plan, &stage, cancelled, &mut tracker)?;
        }

        if request.kind == FileOperationKind::Move {
            for plan in &plans {
                check_cancelled(cancelled)?;
                let quarantine = temporary_sibling(&plan.source, "source");
                rename_noreplace(&plan.source, &quarantine)?;
                quarantines.push((plan.source.clone(), quarantine.clone()));
                if snapshot_entries(&quarantine, cancelled)? != plan.entries {
                    return Err(io::Error::other("source changed while it was being copied"));
                }
            }

            for ((plan, stage), (_, quarantine)) in
                plans.iter().zip(stages.iter()).zip(quarantines.iter())
            {
                verify_staged_copy(quarantine, stage, plan, cancelled)?;
            }
        }

        for ((stage, target), policy) in stages.iter().zip(&targets).zip(&conflict_policies) {
            check_cancelled(cancelled)?;
            committed.push(commit_staged_target(stage, target, *policy)?);
            tracker.emit(Some(target.clone()));
        }
        check_cancelled(cancelled)?;

        // Source and replacement cleanup is irreversible. The Tauri caller removes
        // the job from its cancellation map here, while direct callers still get
        // rollback if their cancellation flag changes during cleanup.
        close_cancel_gate()?;
        if request.kind == FileOperationKind::Move {
            for (index, (source, quarantine)) in quarantines.iter().enumerate() {
                check_cancelled(cancelled)?;
                tracker.emit(Some(source.clone()));
                cleanup_attempted.push(index);
                remove_path(quarantine)?;
                removed_quarantines.push(index);
                check_cancelled(cancelled)?;
            }
        }

        cleanup_backups(&committed);
        Ok::<(), io::Error>(())
    })();

    if let Err(error) = operation {
        let rollback = rollback_transaction(
            &stages,
            &quarantines,
            &cleanup_attempted,
            &removed_quarantines,
            &committed,
        );
        return Err(with_rollback_error(error, rollback));
    }

    tracker.emit(None);
    Ok(FileOperationResult {
        processed_entries: tracker.progress.processed_entries,
        processed_bytes: tracker.progress.processed_bytes,
        targets,
    })
}

fn trash_sources(
    sources: Vec<PathBuf>,
    cancelled: &AtomicBool,
    mut on_progress: impl FnMut(FileOperationProgress),
) -> io::Result<FileOperationResult> {
    check_cancelled(cancelled)?;
    if sources.len() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "batch Trash is disabled because operating-system Trash APIs cannot guarantee rollback after a partial failure",
        ));
    }

    let source = &sources[0];
    let metadata = fs::symlink_metadata(source)?;
    let (total_entries, total_bytes) = if is_link_metadata(&metadata) {
        (1, 0)
    } else {
        let plan = plan_source(source, cancelled)?;
        (plan.entries.len() as u64, plan.total_bytes)
    };

    let mut progress = FileOperationProgress {
        processed_entries: 0,
        total_entries,
        processed_bytes: 0,
        total_bytes,
        current_path: None,
    };
    on_progress(progress.clone());
    check_cancelled(cancelled)?;
    trash::delete(source).map_err(|error| io::Error::other(error.to_string()))?;
    progress.processed_entries = total_entries;
    progress.processed_bytes = total_bytes;
    progress.current_path = Some(source.clone());
    on_progress(progress.clone());
    progress.current_path = None;
    on_progress(progress);
    Ok(FileOperationResult {
        processed_entries: total_entries,
        processed_bytes: total_bytes,
        targets: Vec::new(),
    })
}

fn plan_source(source: &Path, cancelled: &AtomicBool) -> io::Result<SourcePlan> {
    let metadata = fs::symlink_metadata(source)?;
    if is_link_metadata(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("refusing to follow link {}", source.display()),
        ));
    }
    let canonical = fs::canonicalize(source)?;
    let entries = snapshot_entries(source, cancelled)?;
    let total_bytes = entries.iter().map(|entry| entry.len).sum();
    Ok(SourcePlan {
        source: source.to_path_buf(),
        canonical,
        entries,
        total_bytes,
    })
}

fn snapshot_entries(root: &Path, cancelled: &AtomicBool) -> io::Result<Vec<PlannedEntry>> {
    // ponytail: retain one path manifest for safe move verification; stream it
    // only if million-entry directories show measurable memory pressure.
    let mut entries = Vec::new();
    let metadata = fs::symlink_metadata(root)?;
    if is_link_metadata(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("refusing to follow link {}", root.display()),
        ));
    }

    if metadata.is_file() {
        entries.push(planned_entry(PathBuf::new(), &metadata)?);
    } else if metadata.is_dir() {
        for entry in WalkDir::new(root).follow_links(false) {
            check_cancelled(cancelled)?;
            let entry = entry.map_err(io::Error::other)?;
            let metadata = entry.path().symlink_metadata()?;
            if is_link_metadata(&metadata) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("refusing to follow link {}", entry.path().display()),
                ));
            }
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(io::Error::other)?
                .to_path_buf();
            entries.push(planned_entry(relative, &metadata)?);
        }
    } else {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("unsupported source type {}", root.display()),
        ));
    }

    entries.sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(entries)
}

fn planned_entry(relative: PathBuf, metadata: &fs::Metadata) -> io::Result<PlannedEntry> {
    let kind = if metadata.is_dir() {
        PlannedKind::Directory
    } else if metadata.is_file() {
        PlannedKind::File
    } else {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "special filesystem entries are not supported",
        ));
    };
    Ok(PlannedEntry {
        relative,
        kind,
        len: if kind == PlannedKind::File {
            metadata.len()
        } else {
            0
        },
        modified: if kind == PlannedKind::File {
            metadata.modified().ok()
        } else {
            None
        },
    })
}

fn validate_sources(plans: &[SourcePlan], destination: &Path) -> io::Result<()> {
    for (index, plan) in plans.iter().enumerate() {
        if path_starts_with(destination, &plan.canonical) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "destination {} is inside source {}",
                    destination.display(),
                    plan.source.display()
                ),
            ));
        }
        for other in plans.iter().skip(index + 1) {
            if path_starts_with(&plan.canonical, &other.canonical)
                || path_starts_with(&other.canonical, &plan.canonical)
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "sources must not overlap",
                ));
            }
        }
    }
    Ok(())
}

fn resolve_target(
    target: &Path,
    policy: ConflictPolicy,
    reserved: &[PathBuf],
) -> io::Result<PathBuf> {
    let reserved_target = reserved.iter().any(|other| paths_equal(target, other));
    let occupied = |candidate: &Path| {
        candidate
            .try_exists()
            .map(|exists| exists || reserved.iter().any(|other| paths_equal(candidate, other)))
    };

    if !occupied(target)? {
        return Ok(target.to_path_buf());
    }
    match policy {
        ConflictPolicy::Error => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            if reserved_target {
                format!(
                    "multiple sources resolve to destination {}",
                    target.display()
                )
            } else {
                format!("destination already exists: {}", target.display())
            },
        )),
        ConflictPolicy::Replace if reserved_target => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "multiple sources cannot replace destination {}",
                target.display()
            ),
        )),
        ConflictPolicy::Replace => Ok(target.to_path_buf()),
        ConflictPolicy::Rename => {
            let stem = target
                .file_stem()
                .or_else(|| target.file_name())
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "invalid target name")
                })?;
            let extension = target.extension();
            for number in 1.. {
                let mut name = OsString::from(stem);
                name.push(format!(" ({number})"));
                if let Some(extension) = extension {
                    name.push(".");
                    name.push(extension);
                }
                let candidate = target.with_file_name(name);
                if !occupied(&candidate)? {
                    return Ok(candidate);
                }
            }
            unreachable!()
        }
    }
}

fn commit_staged_target(
    stage: &Path,
    target: &Path,
    policy: ConflictPolicy,
) -> io::Result<CommittedTarget> {
    if policy != ConflictPolicy::Replace || !target.try_exists()? {
        rename_noreplace(stage, target)?;
        return Ok(CommittedTarget {
            target: target.to_path_buf(),
            backup: None,
        });
    }

    let backup = temporary_sibling(target, "backup");
    rename_noreplace(target, &backup)?;
    if let Err(error) = rename_noreplace(stage, target) {
        return match rename_noreplace(&backup, target) {
            Ok(()) => Err(error),
            Err(restore_error) => Err(io::Error::new(
                restore_error.kind(),
                format!(
                    "{error}; destination recovery also failed, backup remains at {}: {restore_error}",
                    backup.display()
                ),
            )),
        };
    }
    Ok(CommittedTarget {
        target: target.to_path_buf(),
        backup: Some(backup),
    })
}

#[cfg(test)]
fn commit_stage(stage: &Path, target: &Path, policy: ConflictPolicy) -> io::Result<()> {
    let committed = commit_staged_target(stage, target, policy)?;
    cleanup_backups(std::slice::from_ref(&committed));
    Ok(())
}

fn cleanup_backups(committed: &[CommittedTarget]) {
    for entry in committed {
        if let Some(backup) = &entry.backup
            && let Err(error) = remove_path(backup)
        {
            tracing::warn!(
                path = ?backup,
                error = %error,
                "Replacement committed; preserving backup after cleanup failure"
            );
        }
    }
}

fn restore_source_from_target(target: &Path, source: &Path) -> io::Result<()> {
    if source.try_exists()? {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("cannot restore moved source {}", source.display()),
        ));
    }

    let cancelled = AtomicBool::new(false);
    let plan = plan_source(target, &cancelled)?;
    let stage = temporary_sibling(source, "restore");
    let mut notify = |_progress: FileOperationProgress| {};
    let mut tracker = ProgressTracker {
        progress: FileOperationProgress {
            processed_entries: 0,
            total_entries: plan.entries.len() as u64,
            processed_bytes: 0,
            total_bytes: plan.total_bytes,
            current_path: None,
        },
        notify: &mut notify,
    };
    let result = (|| {
        copy_to_stage(&plan, &stage, &cancelled, &mut tracker)?;
        rename_noreplace(&stage, source)
    })();
    if result.is_err() {
        let _ = remove_path(&stage);
    }
    result
}

fn rollback_transaction(
    stages: &[PathBuf],
    quarantines: &[(PathBuf, PathBuf)],
    cleanup_attempted: &[usize],
    removed_quarantines: &[usize],
    committed: &[CommittedTarget],
) -> io::Result<()> {
    let mut errors = Vec::new();
    let mut source_restored = vec![true; quarantines.len()];

    for (index, (source, quarantine)) in quarantines.iter().enumerate().rev() {
        let cleanup_started =
            cleanup_attempted.contains(&index) || removed_quarantines.contains(&index);
        let result = if cleanup_started {
            match committed.get(index) {
                Some(commit) => restore_source_from_target(&commit.target, source).and_then(|()| {
                    if quarantine.try_exists()? {
                        remove_path(quarantine)?;
                    }
                    Ok(())
                }),
                None => Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("missing committed target {index}"),
                )),
            }
        } else if quarantine.try_exists()? {
            if source.try_exists()? {
                Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("cannot restore moved source {}", source.display()),
                ))
            } else {
                rename_noreplace(quarantine, source)
            }
        } else if source.try_exists()? {
            Ok(())
        } else {
            match committed.get(index) {
                Some(commit) => restore_source_from_target(&commit.target, source),
                None => Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("missing committed target {index}"),
                )),
            }
        };
        if let Err(error) = result {
            source_restored[index] = false;
            errors.push(error.to_string());
        }
    }

    for (index, commit) in committed.iter().enumerate().rev() {
        if source_restored.get(index).is_some_and(|restored| !restored) {
            // Never remove the only complete copy when source recovery failed.
            errors.push(format!(
                "preserving committed target {} because source recovery failed",
                commit.target.display()
            ));
            continue;
        }
        let result = (|| {
            if commit.target.try_exists()? {
                remove_path(&commit.target)?;
            }
            if let Some(backup) = &commit.backup
                && backup.try_exists()?
            {
                rename_noreplace(backup, &commit.target)?;
            }
            Ok::<(), io::Error>(())
        })();
        if let Err(error) = result {
            errors.push(error.to_string());
        }
    }

    for stage in stages.iter().rev() {
        if let Err(error) = remove_path(stage) {
            errors.push(error.to_string());
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "rollback failed: {}",
            errors.join("; ")
        )))
    }
}

fn with_rollback_error(cause: io::Error, rollback: io::Result<()>) -> io::Error {
    match rollback {
        Ok(()) => cause,
        Err(error) => io::Error::new(error.kind(), format!("{cause}; {error}")),
    }
}

fn copy_to_stage<F: FnMut(FileOperationProgress)>(
    plan: &SourcePlan,
    stage: &Path,
    cancelled: &AtomicBool,
    tracker: &mut ProgressTracker<'_, F>,
) -> io::Result<()> {
    let mut directories = Vec::new();
    for entry in &plan.entries {
        check_cancelled(cancelled)?;
        let source = if entry.relative.as_os_str().is_empty() {
            plan.source.clone()
        } else {
            plan.source.join(&entry.relative)
        };
        let destination = if entry.relative.as_os_str().is_empty() {
            stage.to_path_buf()
        } else {
            stage.join(&entry.relative)
        };
        ensure_entry_unchanged(&source, entry)?;

        match entry.kind {
            PlannedKind::Directory => {
                create_directory_from_source(&source, &destination)?;
                directories.push((destination, fs::symlink_metadata(&source)?.permissions()));
                tracker.completed_entry(&source);
            }
            PlannedKind::File => {
                if let Some(parent) = destination.parent()
                    && !parent.is_dir()
                {
                    return Err(io::Error::new(
                        io::ErrorKind::NotFound,
                        format!("staged parent directory is missing: {}", parent.display()),
                    ));
                }
                copy_file(&source, &destination, entry, cancelled, tracker)?;
                tracker.completed_entry(&source);
            }
        }
    }
    for (directory, permissions) in directories.into_iter().rev() {
        fs::set_permissions(directory, permissions)?;
    }
    Ok(())
}

#[cfg(windows)]
fn create_directory_from_source(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryExW;

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let created = unsafe {
        CreateDirectoryExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            std::ptr::null(),
        )
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    if let Err(error) = copy_windows_security(source, destination) {
        let _ = fs::remove_dir(destination);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(windows))]
fn create_directory_from_source(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir(destination)?;
    #[cfg(target_os = "macos")]
    copy_macos_path_metadata(source, destination)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_macos_path_metadata(source: &Path, destination: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "source path contains NUL"))?;
    let destination = CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination path contains NUL")
    })?;
    let result = unsafe {
        libc::copyfile(
            source.as_ptr(),
            destination.as_ptr(),
            std::ptr::null_mut(),
            libc::COPYFILE_METADATA | libc::COPYFILE_NOFOLLOW,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn windows_security_descriptor(path: &Path) -> io::Result<Vec<u8>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, GetFileSecurityW,
        OWNER_SECURITY_INFORMATION,
    };

    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let information =
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    let mut needed = 0;
    unsafe {
        GetFileSecurityW(
            path.as_ptr(),
            information,
            std::ptr::null_mut(),
            0,
            &mut needed,
        );
    }
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut descriptor = vec![0_u8; needed as usize];
    let read = unsafe {
        GetFileSecurityW(
            path.as_ptr(),
            information,
            descriptor.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    if read == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(descriptor)
    }
}

#[cfg(windows)]
fn copy_windows_security(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::{
        DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        SetFileSecurityW,
    };

    let descriptor = windows_security_descriptor(source)?;
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let information =
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    let written = unsafe {
        SetFileSecurityW(
            destination.as_ptr(),
            information,
            descriptor.as_ptr().cast_mut().cast(),
        )
    };
    if written == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn windows_security_equal(source: &[u8], destination: &[u8]) -> io::Result<bool> {
    use windows_sys::Win32::Foundation::BOOL;
    use windows_sys::Win32::Security::{
        ACL, EqualSid, GetSecurityDescriptorDacl, GetSecurityDescriptorGroup,
        GetSecurityDescriptorOwner, PSID,
    };

    unsafe fn descriptor_parts(descriptor: &[u8]) -> io::Result<(PSID, PSID, bool, *mut ACL)> {
        let descriptor = descriptor.as_ptr().cast_mut().cast();
        let mut owner: PSID = std::ptr::null_mut();
        let mut group: PSID = std::ptr::null_mut();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut dacl_present: BOOL = 0;
        let mut defaulted: BOOL = 0;
        if unsafe { GetSecurityDescriptorOwner(descriptor, &mut owner, &mut defaulted) } == 0
            || unsafe { GetSecurityDescriptorGroup(descriptor, &mut group, &mut defaulted) } == 0
            || unsafe {
                GetSecurityDescriptorDacl(descriptor, &mut dacl_present, &mut dacl, &mut defaulted)
            } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok((owner, group, dacl_present != 0, dacl))
    }

    let (source_owner, source_group, source_dacl_present, source_dacl) =
        unsafe { descriptor_parts(source)? };
    let (destination_owner, destination_group, destination_dacl_present, destination_dacl) =
        unsafe { descriptor_parts(destination)? };

    let sid_equal = |left: PSID, right: PSID| {
        if left.is_null() || right.is_null() {
            left == right
        } else {
            unsafe { EqualSid(left, right) != 0 }
        }
    };
    if !sid_equal(source_owner, destination_owner)
        || !sid_equal(source_group, destination_group)
        || source_dacl_present != destination_dacl_present
    {
        return Ok(false);
    }
    if !source_dacl_present || source_dacl.is_null() || destination_dacl.is_null() {
        return Ok(source_dacl == destination_dacl);
    }

    let source_len = unsafe { (*source_dacl).AclSize as usize };
    let destination_len = unsafe { (*destination_dacl).AclSize as usize };
    if source_len != destination_len {
        return Ok(false);
    }
    let source_bytes = unsafe { std::slice::from_raw_parts(source_dacl.cast::<u8>(), source_len) };
    let destination_bytes =
        unsafe { std::slice::from_raw_parts(destination_dacl.cast::<u8>(), destination_len) };
    Ok(source_bytes == destination_bytes)
}

#[cfg(windows)]
fn windows_streams(path: &Path) -> io::Result<Vec<(OsString, u64)>> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Foundation::{ERROR_HANDLE_EOF, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        FindClose, FindFirstStreamW, FindNextStreamW, WIN32_FIND_STREAM_DATA,
    };

    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut data: WIN32_FIND_STREAM_DATA = unsafe { std::mem::zeroed() };
    let handle = unsafe {
        FindFirstStreamW(
            path.as_ptr(),
            0,
            (&mut data as *mut WIN32_FIND_STREAM_DATA).cast(),
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }

    let mut streams = Vec::new();
    let result = loop {
        let length = data
            .cStreamName
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(data.cStreamName.len());
        streams.push((
            OsString::from_wide(&data.cStreamName[..length]),
            data.StreamSize.max(0) as u64,
        ));

        let next =
            unsafe { FindNextStreamW(handle, (&mut data as *mut WIN32_FIND_STREAM_DATA).cast()) };
        if next != 0 {
            continue;
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_HANDLE_EOF as i32) {
            break Ok(());
        }
        break Err(error);
    };
    unsafe {
        FindClose(handle);
    }
    result?;
    streams.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(streams)
}

#[cfg(windows)]
fn path_with_stream(path: &Path, stream: &std::ffi::OsStr) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(stream);
    PathBuf::from(value)
}

#[cfg(windows)]
fn compare_windows_stream(
    source: &Path,
    destination: &Path,
    len: u64,
    cancelled: &AtomicBool,
) -> io::Result<()> {
    let mut source_file = open_source_file(source)?;
    let mut destination_file = open_source_file(destination)?;
    let mut source_buffer = vec![0; COPY_BUFFER_SIZE];
    let mut destination_buffer = vec![0; COPY_BUFFER_SIZE];
    let mut remaining = len;
    while remaining > 0 {
        check_cancelled(cancelled)?;
        let length = remaining.min(COPY_BUFFER_SIZE as u64) as usize;
        source_file.read_exact(&mut source_buffer[..length])?;
        destination_file.read_exact(&mut destination_buffer[..length])?;
        if source_buffer[..length] != destination_buffer[..length] {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("alternate stream mismatch for {}", source.display()),
            ));
        }
        remaining -= length as u64;
    }
    Ok(())
}

#[cfg(windows)]
fn verify_windows_metadata(
    source: &Path,
    destination: &Path,
    cancelled: &AtomicBool,
) -> io::Result<()> {
    let source_security = windows_security_descriptor(source)?;
    let destination_security = windows_security_descriptor(destination)?;
    if !windows_security_equal(&source_security, &destination_security)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("security descriptor mismatch for {}", source.display()),
        ));
    }

    let source_streams = windows_streams(source)?;
    let destination_streams = windows_streams(destination)?;
    if source_streams != destination_streams {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "alternate stream manifest mismatch for {}",
                source.display()
            ),
        ));
    }
    for (name, len) in source_streams {
        if name == "::$DATA" {
            continue;
        }
        compare_windows_stream(
            &path_with_stream(source, &name),
            &path_with_stream(destination, &name),
            len,
            cancelled,
        )?;
    }
    Ok(())
}

#[cfg(windows)]
fn copy_file<F: FnMut(FileOperationProgress)>(
    source: &Path,
    destination: &Path,
    planned: &PlannedEntry,
    cancelled: &AtomicBool,
    tracker: &mut ProgressTracker<'_, F>,
) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::CopyFileExW;

    struct CopyProgress<'a> {
        cancelled: &'a AtomicBool,
        reported_bytes: u64,
        planned_bytes: u64,
        report: &'a mut dyn FnMut(u64),
    }

    unsafe extern "system" fn progress_callback(
        _total_file_size: i64,
        total_bytes_transferred: i64,
        _stream_size: i64,
        _stream_bytes_transferred: i64,
        _stream_number: u32,
        _callback_reason: u32,
        _source_handle: windows_sys::Win32::Foundation::HANDLE,
        _destination_handle: windows_sys::Win32::Foundation::HANDLE,
        data: *const core::ffi::c_void,
    ) -> u32 {
        let context = unsafe { &mut *(data as *mut CopyProgress<'_>) };
        let transferred = (total_bytes_transferred.max(0) as u64).min(context.planned_bytes);
        if transferred > context.reported_bytes {
            (context.report)(transferred - context.reported_bytes);
            context.reported_bytes = transferred;
        }
        if context.cancelled.load(Ordering::Relaxed) {
            1 // PROGRESS_CANCEL: CopyFileEx removes the partial destination.
        } else {
            0 // PROGRESS_CONTINUE
        }
    }

    ensure_entry_unchanged(source, planned)?;
    check_cancelled(cancelled)?;
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut report = |bytes| tracker.copied_bytes(source, bytes);
    let mut context = CopyProgress {
        cancelled,
        reported_bytes: 0,
        planned_bytes: planned.len,
        report: &mut report,
    };

    let copied = unsafe {
        CopyFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            Some(progress_callback),
            (&mut context as *mut CopyProgress<'_>).cast(),
            std::ptr::null_mut(),
            1, // COPY_FILE_FAIL_IF_EXISTS
        )
    };
    if copied == 0 {
        let error = if cancelled.load(Ordering::Relaxed) {
            io::Error::new(io::ErrorKind::Interrupted, "file operation cancelled")
        } else {
            io::Error::last_os_error()
        };
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    if context.reported_bytes < planned.len {
        (context.report)(planned.len - context.reported_bytes);
    }

    copy_windows_security(source, destination)?;
    ensure_entry_unchanged(source, planned)?;
    let destination_len = fs::symlink_metadata(destination)?.len();
    if destination_len != planned.len {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("copied size mismatch for {}", source.display()),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn copy_file<F: FnMut(FileOperationProgress)>(
    source: &Path,
    destination: &Path,
    planned: &PlannedEntry,
    cancelled: &AtomicBool,
    tracker: &mut ProgressTracker<'_, F>,
) -> io::Result<()> {
    let mut source_file = open_source_file(source)?;
    let opened_metadata = source_file.metadata()?;
    ensure_metadata_unchanged(source, &opened_metadata, planned)?;
    let mut destination_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let mut buffer = vec![0; COPY_BUFFER_SIZE];
    let mut copied = 0;
    loop {
        check_cancelled(cancelled)?;
        let read = source_file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        destination_file.write_all(&buffer[..read])?;
        copied += read as u64;
        tracker.copied_bytes(source, read as u64);
    }
    if let Some(modified) = planned.modified {
        destination_file.set_times(fs::FileTimes::new().set_modified(modified))?;
    }
    #[cfg(target_os = "macos")]
    copy_macos_metadata(&source_file, &destination_file)?;
    destination_file.set_permissions(opened_metadata.permissions())?;
    destination_file.sync_all()?;
    ensure_entry_unchanged(source, planned)?;

    let destination_len = fs::symlink_metadata(destination)?.len();
    if copied != planned.len || destination_len != planned.len {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("copied size mismatch for {}", source.display()),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_macos_metadata(source: &File, destination: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    let result = unsafe {
        libc::fcopyfile(
            source.as_raw_fd(),
            destination.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_METADATA,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn open_source_file(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(windows)]
fn open_source_file(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn open_source_file(path: &Path) -> io::Result<File> {
    File::open(path)
}

fn ensure_entry_unchanged(path: &Path, planned: &PlannedEntry) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if is_link_metadata(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("source became a link: {}", path.display()),
        ));
    }
    ensure_metadata_unchanged(path, &metadata, planned)
}

fn ensure_metadata_unchanged(
    path: &Path,
    metadata: &fs::Metadata,
    planned: &PlannedEntry,
) -> io::Result<()> {
    let actual_kind = if metadata.is_dir() {
        PlannedKind::Directory
    } else if metadata.is_file() {
        PlannedKind::File
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("source type changed: {}", path.display()),
        ));
    };
    let changed = actual_kind != planned.kind
        || (actual_kind == PlannedKind::File
            && (metadata.len() != planned.len || metadata.modified().ok() != planned.modified));
    if changed {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("source changed while copying: {}", path.display()),
        ))
    } else {
        Ok(())
    }
}

fn verify_staged_copy(
    source_root: &Path,
    staged_root: &Path,
    plan: &SourcePlan,
    cancelled: &AtomicBool,
) -> io::Result<()> {
    let mut source_buffer = vec![0; COPY_BUFFER_SIZE];
    let mut staged_buffer = vec![0; COPY_BUFFER_SIZE];
    for entry in &plan.entries {
        check_cancelled(cancelled)?;
        if entry.kind != PlannedKind::File {
            continue;
        }
        let source = if entry.relative.as_os_str().is_empty() {
            source_root.to_path_buf()
        } else {
            source_root.join(&entry.relative)
        };
        let staged = if entry.relative.as_os_str().is_empty() {
            staged_root.to_path_buf()
        } else {
            staged_root.join(&entry.relative)
        };
        ensure_entry_unchanged(&source, entry)?;
        let staged_metadata = fs::symlink_metadata(&staged)?;
        let staged_kind = if staged_metadata.is_dir() {
            PlannedKind::Directory
        } else if staged_metadata.is_file() {
            PlannedKind::File
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("staged type mismatch for {}", staged.display()),
            ));
        };
        if staged_kind != entry.kind
            || (staged_kind == PlannedKind::File && staged_metadata.len() != entry.len)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("staged metadata mismatch for {}", staged.display()),
            ));
        }

        #[cfg(windows)]
        verify_windows_metadata(&source, &staged, cancelled)?;

        let mut source_file = open_source_file(&source)?;
        let mut staged_file = open_source_file(&staged)?;
        let mut remaining = entry.len;
        while remaining > 0 {
            check_cancelled(cancelled)?;
            let length = remaining.min(COPY_BUFFER_SIZE as u64) as usize;
            source_file.read_exact(&mut source_buffer[..length])?;
            staged_file.read_exact(&mut staged_buffer[..length])?;
            if source_buffer[..length] != staged_buffer[..length] {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("copied content mismatch for {}", source.display()),
                ));
            }
            remaining -= length as u64;
        }
    }
    Ok(())
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

fn temporary_sibling(path: &Path, purpose: &str) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(".explorie-{purpose}-{}", Uuid::new_v4()))
}

fn check_cancelled(cancelled: &AtomicBool) -> io::Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "file operation cancelled",
        ))
    } else {
        Ok(())
    }
}

fn same_path(source_canonical: &Path, target: &Path) -> io::Result<bool> {
    if !target.try_exists()? {
        return Ok(false);
    }
    Ok(paths_equal(source_canonical, &fs::canonicalize(target)?))
}

fn path_starts_with(path: &Path, prefix: &Path) -> bool {
    let mut path = path.components();
    let mut prefix = prefix.components();
    loop {
        match prefix.next() {
            None => return true,
            Some(prefix) => match path.next() {
                Some(path) if components_equal(path.as_os_str(), prefix.as_os_str()) => {}
                _ => return false,
            },
        }
    }
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    let mut left = left.components();
    let mut right = right.components();
    loop {
        match (left.next(), right.next()) {
            (None, None) => return true,
            (Some(left), Some(right)) if components_equal(left.as_os_str(), right.as_os_str()) => {}
            _ => return false,
        }
    }
}

#[cfg(windows)]
fn components_equal(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(not(windows))]
fn components_equal(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
    left == right
}

#[cfg(windows)]
pub fn rename_noreplace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};

    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub fn rename_noreplace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn rename_noreplace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "linux", target_os = "android"))
))]
pub fn rename_noreplace(source: &Path, destination: &Path) -> io::Result<()> {
    if destination.try_exists()? {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "destination already exists",
        ));
    }
    fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use tempfile::tempdir;

    fn request(
        kind: FileOperationKind,
        source: &Path,
        destination: &Path,
        conflict_policy: ConflictPolicy,
    ) -> FileOperationRequest {
        FileOperationRequest {
            kind,
            sources: vec![source.to_path_buf()],
            destination: Some(destination.to_path_buf()),
            conflict_policy,
            conflict_policies: None,
        }
    }

    #[test]
    fn copy_directory_reports_progress_and_preserves_content() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::create_dir(&destination).unwrap();
        let source_file = source.join("nested/data.txt");
        fs::write(&source_file, b"content").unwrap();
        let modified = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        OpenOptions::new()
            .write(true)
            .open(&source_file)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let mut progress = Vec::new();

        let result = perform_file_operation(
            request(
                FileOperationKind::Copy,
                &source,
                &destination,
                ConflictPolicy::Error,
            ),
            &AtomicBool::new(false),
            |update| progress.push(update),
        )
        .unwrap();

        assert_eq!(
            fs::read(destination.join("source/nested/data.txt")).unwrap(),
            b"content"
        );
        assert_eq!(result.processed_bytes, 7);
        assert_eq!(progress.last().unwrap().processed_bytes, 7);
        assert_eq!(
            fs::metadata(destination.join("source/nested/data.txt"))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
    }

    #[test]
    fn cancelled_replace_leaves_existing_destination_untouched() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("item.txt");
        let destination = temp.path().join("destination");
        fs::create_dir(&destination).unwrap();
        fs::write(&source, b"new").unwrap();
        fs::write(destination.join("item.txt"), b"old").unwrap();

        let result = perform_file_operation(
            request(
                FileOperationKind::Copy,
                &source,
                &destination,
                ConflictPolicy::Replace,
            ),
            &AtomicBool::new(true),
            |_| {},
        );

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert_eq!(fs::read(destination.join("item.txt")).unwrap(), b"old");
        assert_eq!(fs::read(source).unwrap(), b"new");
    }

    #[test]
    fn mid_copy_cancellation_removes_stage_and_preserves_source() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("large.bin");
        let destination = temp.path().join("destination");
        fs::create_dir(&destination).unwrap();
        fs::write(&source, vec![0x5a; COPY_BUFFER_SIZE * 8]).unwrap();
        let cancelled = AtomicBool::new(false);

        let result = perform_file_operation(
            request(
                FileOperationKind::Copy,
                &source,
                &destination,
                ConflictPolicy::Error,
            ),
            &cancelled,
            |progress| {
                if progress.processed_bytes > 0 {
                    cancelled.store(true, Ordering::Relaxed);
                }
            },
        );

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert_eq!(
            fs::metadata(&source).unwrap().len(),
            (COPY_BUFFER_SIZE * 8) as u64
        );
        assert!(!destination.join("large.bin").exists());
        assert!(fs::read_dir(&destination).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("explorie-copy")
        }));
    }

    #[test]
    fn multi_item_copy_reports_one_aggregate_progress_stream() {
        let temp = tempdir().unwrap();
        let source_dir = temp.path().join("sources");
        let destination = temp.path().join("destination");
        fs::create_dir(&source_dir).unwrap();
        fs::create_dir(&destination).unwrap();
        let sources: Vec<_> = [1_usize, 2, 3]
            .into_iter()
            .enumerate()
            .map(|(index, size)| {
                let source = source_dir.join(format!("item-{index}.txt"));
                fs::write(&source, vec![b'x'; size]).unwrap();
                source
            })
            .collect();
        let mut progress = Vec::new();

        let result = perform_file_operation(
            FileOperationRequest {
                kind: FileOperationKind::Copy,
                sources,
                destination: Some(destination),
                conflict_policy: ConflictPolicy::Error,
                conflict_policies: None,
            },
            &AtomicBool::new(false),
            |update| progress.push(update),
        )
        .unwrap();

        assert_eq!(result.processed_entries, 3);
        assert_eq!(result.processed_bytes, 6);
        assert!(
            progress
                .iter()
                .all(|update| update.total_entries == 3 && update.total_bytes == 6)
        );
        assert!(progress.windows(2).all(|updates| {
            updates[0].processed_entries <= updates[1].processed_entries
                && updates[0].processed_bytes <= updates[1].processed_bytes
        }));
        let final_progress = progress.last().unwrap();
        assert_eq!(final_progress.processed_entries, 3);
        assert_eq!(final_progress.processed_bytes, 6);
    }

    #[test]
    fn batch_copy_applies_each_sources_conflict_policy() {
        let temp = tempdir().unwrap();
        let source_dir = temp.path().join("sources");
        let destination = temp.path().join("destination");
        fs::create_dir(&source_dir).unwrap();
        fs::create_dir(&destination).unwrap();
        let replace_source = source_dir.join("replace.txt");
        let rename_source = source_dir.join("rename.txt");
        fs::write(&replace_source, b"new replace").unwrap();
        fs::write(&rename_source, b"new rename").unwrap();
        fs::write(destination.join("replace.txt"), b"old replace").unwrap();
        fs::write(destination.join("rename.txt"), b"old rename").unwrap();

        let result = perform_file_operation(
            FileOperationRequest {
                kind: FileOperationKind::Copy,
                sources: vec![replace_source, rename_source],
                destination: Some(destination.clone()),
                conflict_policy: ConflictPolicy::Error,
                conflict_policies: Some(vec![ConflictPolicy::Replace, ConflictPolicy::Rename]),
            },
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();

        assert_eq!(
            fs::read(destination.join("replace.txt")).unwrap(),
            b"new replace"
        );
        assert_eq!(
            fs::read(destination.join("rename.txt")).unwrap(),
            b"old rename"
        );
        assert_eq!(
            fs::read(destination.join("rename (1).txt")).unwrap(),
            b"new rename"
        );
        assert_eq!(
            result.targets,
            vec![
                destination.join("replace.txt"),
                destination.join("rename (1).txt")
            ]
        );
    }

    #[test]
    fn cancelled_batch_copy_stops_before_later_items_and_removes_inflight_stage() {
        let temp = tempdir().unwrap();
        let source_dir = temp.path().join("sources");
        let destination = temp.path().join("destination");
        fs::create_dir(&source_dir).unwrap();
        fs::create_dir(&destination).unwrap();
        let sources: Vec<_> = (0..3)
            .map(|index| {
                let source = source_dir.join(format!("item-{index}.bin"));
                fs::write(&source, vec![index as u8; COPY_BUFFER_SIZE * 3]).unwrap();
                source
            })
            .collect();
        let cancelled = AtomicBool::new(false);

        let result = perform_file_operation(
            FileOperationRequest {
                kind: FileOperationKind::Copy,
                sources: sources.clone(),
                destination: Some(destination.clone()),
                conflict_policy: ConflictPolicy::Error,
                conflict_policies: None,
            },
            &cancelled,
            |progress| {
                if progress.processed_bytes > 0 {
                    cancelled.store(true, Ordering::Relaxed);
                }
            },
        );

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert!(sources.iter().all(|source| source.exists()));
        assert!(fs::read_dir(destination).unwrap().next().is_none());
    }

    #[test]
    fn cancelled_batch_move_restores_sources_and_removes_inflight_stage() {
        let temp = tempdir().unwrap();
        let source_dir = temp.path().join("sources");
        let destination = temp.path().join("destination");
        fs::create_dir(&source_dir).unwrap();
        fs::create_dir(&destination).unwrap();
        let sources: Vec<_> = (0..3)
            .map(|index| {
                let source = source_dir.join(format!("item-{index}.bin"));
                fs::write(&source, vec![index as u8; COPY_BUFFER_SIZE * 3]).unwrap();
                source
            })
            .collect();
        let cancelled = AtomicBool::new(false);

        let result = perform_file_operation(
            FileOperationRequest {
                kind: FileOperationKind::Move,
                sources: sources.clone(),
                destination: Some(destination.clone()),
                conflict_policy: ConflictPolicy::Error,
                conflict_policies: None,
            },
            &cancelled,
            |progress| {
                if progress.processed_bytes > 0 {
                    cancelled.store(true, Ordering::Relaxed);
                }
            },
        );

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert!(sources.iter().all(|source| source.exists()));
        assert!(fs::read_dir(destination).unwrap().next().is_none());
        assert!(fs::read_dir(source_dir).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".explorie-")
        }));
    }

    #[test]
    fn cancellation_during_final_move_cleanup_rolls_back_source_and_target() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(source.join("nested/data.txt"), b"content").unwrap();
        let target = destination.join("source");
        let cancelled = AtomicBool::new(false);
        let cleanup_started = AtomicBool::new(false);

        let result = perform_file_operation(
            request(
                FileOperationKind::Move,
                &source,
                &destination,
                ConflictPolicy::Error,
            ),
            &cancelled,
            |progress| {
                if progress.current_path.as_ref() == Some(&source) && target.exists() {
                    assert!(!source.exists(), "move source must already be quarantined");
                    cleanup_started.store(true, Ordering::Relaxed);
                    cancelled.store(true, Ordering::Relaxed);
                }
            },
        );

        assert!(cleanup_started.load(Ordering::Relaxed));
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert_eq!(
            fs::read(source.join("nested/data.txt")).unwrap(),
            b"content"
        );
        assert!(!target.exists());
        assert!(fs::read_dir(temp.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".explorie-")
        }));
    }

    #[test]
    fn partial_move_cleanup_restores_complete_target_before_removing_it() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let quarantine = temp.path().join(".explorie-source-partial");
        let destination = temp.path().join("destination");
        let target = destination.join("source");
        fs::create_dir(&destination).unwrap();
        fs::create_dir_all(quarantine.join("nested")).unwrap();
        fs::write(quarantine.join("nested/partial.txt"), b"partial").unwrap();
        fs::create_dir_all(target.join("nested")).unwrap();
        fs::write(target.join("nested/complete.txt"), b"complete").unwrap();

        rollback_transaction(
            &[],
            &[(source.clone(), quarantine.clone())],
            &[0],
            &[],
            &[CommittedTarget {
                target: target.clone(),
                backup: None,
            }],
        )
        .unwrap();

        assert_eq!(
            fs::read(source.join("nested/complete.txt")).unwrap(),
            b"complete"
        );
        assert!(!source.join("nested/partial.txt").exists());
        assert!(!target.exists());
        assert!(!quarantine.exists());
    }

    #[test]
    fn failed_source_recovery_preserves_the_complete_committed_target() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let quarantine = temp.path().join(".explorie-source-conflict");
        let destination = temp.path().join("destination");
        let target = destination.join("source");
        fs::create_dir(&destination).unwrap();
        fs::create_dir(&source).unwrap();
        fs::create_dir(&quarantine).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(source.join("unexpected.txt"), b"unexpected").unwrap();
        fs::write(target.join("complete.txt"), b"complete").unwrap();

        let result = rollback_transaction(
            &[],
            &[(source.clone(), quarantine)],
            &[0],
            &[],
            &[CommittedTarget {
                target: target.clone(),
                backup: None,
            }],
        );

        assert!(result.is_err());
        assert_eq!(fs::read(target.join("complete.txt")).unwrap(), b"complete");
    }

    #[test]
    fn cancelled_during_batch_commit_rolls_back_the_completed_target() {
        let temp = tempdir().unwrap();
        let source_dir = temp.path().join("sources");
        let destination = temp.path().join("destination");
        fs::create_dir(&source_dir).unwrap();
        fs::create_dir(&destination).unwrap();
        let first = source_dir.join("first.txt");
        let second = source_dir.join("second.txt");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        let first_target = destination.join("first.txt");
        let cancelled = AtomicBool::new(false);

        let result = perform_file_operation(
            FileOperationRequest {
                kind: FileOperationKind::Copy,
                sources: vec![first.clone(), second.clone()],
                destination: Some(destination.clone()),
                conflict_policy: ConflictPolicy::Error,
                conflict_policies: None,
            },
            &cancelled,
            |progress| {
                if progress.current_path.as_ref() == Some(&first_target) {
                    cancelled.store(true, Ordering::Relaxed);
                }
            },
        );

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert!(first.exists());
        assert!(second.exists());
        assert!(fs::read_dir(destination).unwrap().next().is_none());
    }

    #[test]
    fn cancelled_move_replace_preserves_source_and_destination() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("item.txt");
        let destination = temp.path().join("destination");
        fs::create_dir(&destination).unwrap();
        fs::write(&source, b"new").unwrap();
        fs::write(destination.join("item.txt"), b"old").unwrap();

        let result = perform_file_operation(
            request(
                FileOperationKind::Move,
                &source,
                &destination,
                ConflictPolicy::Replace,
            ),
            &AtomicBool::new(true),
            |_| {},
        );

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert_eq!(fs::read(source).unwrap(), b"new");
        assert_eq!(fs::read(destination.join("item.txt")).unwrap(), b"old");
    }

    #[test]
    fn move_rename_policy_never_overwrites_existing_file() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("item.txt");
        let destination = temp.path().join("destination");
        fs::create_dir(&destination).unwrap();
        fs::write(&source, b"new").unwrap();
        fs::write(destination.join("item.txt"), b"old").unwrap();

        let result = perform_file_operation(
            request(
                FileOperationKind::Move,
                &source,
                &destination,
                ConflictPolicy::Rename,
            ),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(destination.join("item.txt")).unwrap(), b"old");
        assert_eq!(fs::read(destination.join("item (1).txt")).unwrap(), b"new");
        assert_eq!(result.targets, vec![destination.join("item (1).txt")]);
    }

    #[test]
    fn same_volume_move_replaces_transactionally() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("item.txt");
        let destination = temp.path().join("destination");
        fs::create_dir(&destination).unwrap();
        fs::write(&source, b"new").unwrap();
        fs::write(destination.join("item.txt"), b"old").unwrap();

        perform_file_operation(
            request(
                FileOperationKind::Move,
                &source,
                &destination,
                ConflictPolicy::Replace,
            ),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(destination.join("item.txt")).unwrap(), b"new");
    }

    #[test]
    fn rejects_destination_inside_source() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = source.join("nested");
        fs::create_dir_all(&destination).unwrap();

        let result = perform_file_operation(
            request(
                FileOperationKind::Copy,
                &source,
                &destination,
                ConflictPolicy::Error,
            ),
            &AtomicBool::new(false),
            |_| {},
        );

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn staged_verification_detects_same_size_content_corruption() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source.txt");
        let staged = temp.path().join("staged.txt");
        fs::write(&source, b"good").unwrap();
        fs::write(&staged, b"evil").unwrap();
        let plan = plan_source(&source, &AtomicBool::new(false)).unwrap();

        let result = verify_staged_copy(&source, &staged, &plan, &AtomicBool::new(false));

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn failed_replace_restores_the_existing_destination() {
        let temp = tempdir().unwrap();
        let target = temp.path().join("target.txt");
        let missing_stage = temp.path().join("missing-stage.txt");
        fs::write(&target, b"old").unwrap();

        let result = commit_stage(&missing_stage, &target, ConflictPolicy::Replace);

        assert!(result.is_err());
        assert_eq!(fs::read(target).unwrap(), b"old");
    }

    #[test]
    fn batch_trash_fails_before_moving_any_source() {
        let temp = tempdir().unwrap();
        let first = temp.path().join("first.txt");
        let second = temp.path().join("second.txt");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();

        let result = perform_file_operation(
            FileOperationRequest {
                kind: FileOperationKind::Trash,
                sources: vec![first.clone(), second.clone()],
                destination: None,
                conflict_policy: ConflictPolicy::Error,
                conflict_policies: None,
            },
            &AtomicBool::new(false),
            |_| {},
        );

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidInput);
        assert_eq!(fs::read(first).unwrap(), b"first");
        assert_eq!(fs::read(second).unwrap(), b"second");
    }

    #[cfg(windows)]
    #[test]
    fn windows_copy_preserves_alternate_data_streams() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source.txt");
        let source_stream = PathBuf::from(format!("{}:explorie", source.display()));
        let destination = temp.path().join("destination");
        fs::create_dir(&destination).unwrap();
        fs::write(&source, b"primary").unwrap();
        if fs::write(&source_stream, b"alternate").is_err() {
            eprintln!("skipping alternate stream test: filesystem does not support ADS");
            return;
        }

        perform_file_operation(
            request(
                FileOperationKind::Copy,
                &source,
                &destination,
                ConflictPolicy::Error,
            ),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();

        let copied_stream = destination.join("source.txt:explorie");
        assert_eq!(fs::read(copied_stream).unwrap(), b"alternate");
    }

    #[cfg(windows)]
    #[test]
    fn cross_volume_move_preserves_content_and_streams_when_configured() {
        let Some(other_volume) = std::env::var_os("EXPLORIE_CROSS_VOLUME_TEST_DIR") else {
            eprintln!("skipping cross-volume test: EXPLORIE_CROSS_VOLUME_TEST_DIR is unset");
            return;
        };
        let source_root = tempdir().unwrap();
        let destination_root = tempfile::Builder::new()
            .prefix("explorie-cross-volume-")
            .tempdir_in(other_volume)
            .unwrap();
        let source = source_root.path().join("source.txt");
        fs::write(&source, b"primary").unwrap();
        let source_stream = PathBuf::from(format!("{}:explorie", source.display()));
        fs::write(&source_stream, b"alternate").unwrap();

        let result = perform_file_operation(
            request(
                FileOperationKind::Move,
                &source,
                destination_root.path(),
                ConflictPolicy::Error,
            ),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();

        let target = &result.targets[0];
        assert!(!source.exists());
        assert_eq!(fs::read(target).unwrap(), b"primary");
        assert_eq!(
            fs::read(PathBuf::from(format!("{}:explorie", target.display()))).unwrap(),
            b"alternate"
        );
    }

    #[cfg(windows)]
    #[test]
    fn cross_volume_move_cancellation_after_source_cleanup_starts_restores_source() {
        let Some(other_volume) = std::env::var_os("EXPLORIE_CROSS_VOLUME_TEST_DIR") else {
            eprintln!(
                "skipping cross-volume cancellation test: EXPLORIE_CROSS_VOLUME_TEST_DIR is unset"
            );
            return;
        };
        let source_root = tempdir().unwrap();
        let destination_root = tempfile::Builder::new()
            .prefix("explorie-cross-volume-cancel-")
            .tempdir_in(other_volume)
            .unwrap();
        let source = source_root.path().join("source.txt");
        fs::write(&source, b"primary").unwrap();
        let target = destination_root.path().join("source.txt");
        let cancelled = AtomicBool::new(false);
        let cleanup_started = AtomicBool::new(false);

        let result = perform_file_operation(
            request(
                FileOperationKind::Move,
                &source,
                destination_root.path(),
                ConflictPolicy::Error,
            ),
            &cancelled,
            |progress| {
                if progress.current_path.as_ref() == Some(&source) && target.exists() {
                    cleanup_started.store(true, Ordering::Relaxed);
                    cancelled.store(true, Ordering::Relaxed);
                }
            },
        );

        assert!(cleanup_started.load(Ordering::Relaxed));
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert_eq!(fs::read(&source).unwrap(), b"primary");
        assert!(!target.exists());
        assert!(source_root.path().read_dir().unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".explorie-")
        }));
    }

    #[cfg(windows)]
    #[test]
    fn cross_volume_move_fails_closed_when_metadata_cannot_be_preserved() {
        let Some(other_volume) = std::env::var_os("EXPLORIE_UNSUPPORTED_VOLUME_TEST_DIR") else {
            eprintln!(
                "skipping unsupported-volume test: EXPLORIE_UNSUPPORTED_VOLUME_TEST_DIR is unset"
            );
            return;
        };
        let source_root = tempdir().unwrap();
        let destination_root = tempfile::Builder::new()
            .prefix("explorie-unsupported-volume-")
            .tempdir_in(other_volume)
            .unwrap();
        let source = source_root.path().join("source.txt");
        fs::write(&source, b"primary").unwrap();
        fs::write(
            PathBuf::from(format!("{}:explorie", source.display())),
            b"alternate",
        )
        .unwrap();

        let result = perform_file_operation(
            request(
                FileOperationKind::Move,
                &source,
                destination_root.path(),
                ConflictPolicy::Error,
            ),
            &AtomicBool::new(false),
            |_| {},
        );

        assert!(result.is_err());
        assert_eq!(fs::read(&source).unwrap(), b"primary");
        assert!(!destination_root.path().join("source.txt").exists());
    }

    #[cfg(windows)]
    #[test]
    fn cross_volume_directory_move_preserves_streams_when_configured() {
        let Some(other_volume) = std::env::var_os("EXPLORIE_CROSS_VOLUME_TEST_DIR") else {
            eprintln!("skipping cross-volume test: EXPLORIE_CROSS_VOLUME_TEST_DIR is unset");
            return;
        };
        let source_root = tempdir().unwrap();
        let destination_root = tempfile::Builder::new()
            .prefix("explorie-cross-volume-directory-")
            .tempdir_in(other_volume)
            .unwrap();
        let source = source_root.path().join("folder");
        fs::create_dir(&source).unwrap();
        let nested = source.join("nested.txt");
        fs::write(&nested, b"primary").unwrap();
        fs::write(
            PathBuf::from(format!("{}:directory", source.display())),
            b"directory stream",
        )
        .unwrap();
        fs::write(
            PathBuf::from(format!("{}:file", nested.display())),
            b"file stream",
        )
        .unwrap();

        let result = perform_file_operation(
            request(
                FileOperationKind::Move,
                &source,
                destination_root.path(),
                ConflictPolicy::Error,
            ),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();

        let target = &result.targets[0];
        assert!(!source.exists());
        assert_eq!(fs::read(target.join("nested.txt")).unwrap(), b"primary");
        assert_eq!(
            fs::read(PathBuf::from(format!("{}:directory", target.display()))).unwrap(),
            b"directory stream"
        );
        assert_eq!(
            fs::read(PathBuf::from(format!(
                "{}:file",
                target.join("nested.txt").display()
            )))
            .unwrap(),
            b"file stream"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_copy_preserves_extended_attributes() {
        use std::process::Command;

        let temp = tempdir().unwrap();
        let source = temp.path().join("source.txt");
        let destination = temp.path().join("destination");
        fs::create_dir(&destination).unwrap();
        fs::write(&source, b"primary").unwrap();
        let status = Command::new("xattr")
            .arg("-w")
            .arg("com.omershatz.explorie.test")
            .arg("metadata")
            .arg(&source)
            .status()
            .unwrap();
        assert!(status.success());

        perform_file_operation(
            request(
                FileOperationKind::Copy,
                &source,
                &destination,
                ConflictPolicy::Error,
            ),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();

        let output = Command::new("xattr")
            .arg("-p")
            .arg("com.omershatz.explorie.test")
            .arg(destination.join("source.txt"))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "metadata");
    }

    #[cfg(unix)]
    #[test]
    fn copy_rejects_symlinks_without_touching_the_target() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().unwrap();
        let outside = temp.path().join("outside.txt");
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(&outside, b"outside").unwrap();
        symlink(&outside, source.join("link.txt")).unwrap();

        let result = perform_file_operation(
            request(
                FileOperationKind::Copy,
                &source,
                &destination,
                ConflictPolicy::Error,
            ),
            &AtomicBool::new(false),
            |_| {},
        );

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidInput);
        assert_eq!(fs::read(outside).unwrap(), b"outside");
        assert!(!destination.join("source").exists());
    }
}
