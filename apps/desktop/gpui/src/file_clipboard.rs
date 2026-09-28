//! The system file clipboard behind Copy, Cut and Paste.
//!
//! Windows talk to it through [`FileClipboard`] so tests can substitute an
//! in-memory clipboard and never replace what the user copied.

use std::path::PathBuf;

use explorie_native_services::ServiceResult;
use explorie_native_services::clipboard::{self, ClipboardFiles};

use crate::operation::{ClipboardKind, ClipboardState};

pub(crate) trait FileClipboard {
    /// Replace the clipboard contents with `paths`, marked as cut when `cut`.
    fn write(&self, paths: &[PathBuf], cut: bool) -> ServiceResult<()>;
    /// The files on the clipboard, or `None` when it holds something else.
    fn read(&self) -> ServiceResult<Option<ClipboardFiles>>;
    /// Empty the clipboard.
    fn clear(&self) -> ServiceResult<()>;
}

/// The platform clipboard: NSPasteboard on macOS, CF_HDROP on Windows.
#[cfg_attr(test, allow(dead_code))]
pub(crate) struct SystemFileClipboard;

impl FileClipboard for SystemFileClipboard {
    fn write(&self, paths: &[PathBuf], cut: bool) -> ServiceResult<()> {
        clipboard::write_files(paths, cut)
    }

    fn read(&self) -> ServiceResult<Option<ClipboardFiles>> {
        clipboard::read_files()
    }

    fn clear(&self) -> ServiceResult<()> {
        clipboard::clear()
    }
}

/// What the system clipboard held when it was last read or written.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) enum SystemClipboard {
    /// Not read yet, or unreadable: Paste falls back to the in-app state.
    #[default]
    Unknown,
    /// Files to paste.
    Files(ClipboardState),
    /// Nothing pasteable (no files, or text).
    Empty,
}

impl SystemClipboard {
    pub(crate) fn from_files(files: Option<ClipboardFiles>) -> Self {
        match files {
            Some(files) if !files.paths.is_empty() => Self::Files(ClipboardState {
                kind: if files.cut {
                    ClipboardKind::Cut
                } else {
                    ClipboardKind::Copy
                },
                paths: files.paths,
            }),
            _ => Self::Empty,
        }
    }
}

/// An in-memory clipboard for tests.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryFileClipboard {
    pub(crate) contents: std::sync::Mutex<Option<ClipboardFiles>>,
    /// Make reads fail, like a platform without a file clipboard.
    pub(crate) unreadable: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl MemoryFileClipboard {
    pub(crate) fn contents(&self) -> Option<ClipboardFiles> {
        self.contents.lock().unwrap().clone()
    }

    pub(crate) fn set(&self, contents: Option<ClipboardFiles>) {
        *self.contents.lock().unwrap() = contents;
    }
}

#[cfg(test)]
impl FileClipboard for MemoryFileClipboard {
    fn write(&self, paths: &[PathBuf], cut: bool) -> ServiceResult<()> {
        self.set(Some(ClipboardFiles {
            paths: paths.to_vec(),
            cut,
        }));
        Ok(())
    }

    fn read(&self) -> ServiceResult<Option<ClipboardFiles>> {
        if self.unreadable.load(std::sync::atomic::Ordering::Acquire) {
            return Err(explorie_native_services::ServiceError::new(
                explorie_native_services::ErrorCode::Unsupported,
                "The system file clipboard is unavailable",
            ));
        }
        Ok(self.contents())
    }

    fn clear(&self) -> ServiceResult<()> {
        self.set(None);
        Ok(())
    }
}

/// The clipboard new windows use: the system one, or in tests a private
/// in-memory one.
pub(crate) fn default_file_clipboard() -> std::rc::Rc<dyn FileClipboard> {
    #[cfg(test)]
    {
        std::rc::Rc::new(MemoryFileClipboard::default())
    }
    #[cfg(not(test))]
    {
        std::rc::Rc::new(SystemFileClipboard)
    }
}
