use serde::{Deserialize, Serialize};
use std::fmt;
use std::io;
use tracing::warn;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppErrorCode {
    Permission,
    MissingPath,
    Conflict,
    Cancelled,
    HelperMissing,
    RemoteUnavailable,
    InvalidName,
    InUse,
    DiskFull,
    Archive,
    Path,
    TypeMismatch,
    Unsupported,
    Unknown,
}

impl AppErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Permission => "permission",
            Self::MissingPath => "missing_path",
            Self::Conflict => "conflict",
            Self::Cancelled => "cancelled",
            Self::HelperMissing => "helper_missing",
            Self::RemoteUnavailable => "remote_unavailable",
            Self::InvalidName => "invalid_name",
            Self::InUse => "in_use",
            Self::DiskFull => "disk_full",
            Self::Archive => "archive",
            Self::Path => "path",
            Self::TypeMismatch => "type_mismatch",
            Self::Unsupported => "unsupported",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: AppErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    pub fn from_raw(operation: &'static str, source: impl AsRef<str>) -> Self {
        let source = source.as_ref();
        let code = classify(source);
        let error = Self {
            code,
            message: specific_user_message(code, source),
            retryable: is_retryable(code),
            operation: Some(operation.to_string()),
            detail: sanitize_diagnostic(source),
        };
        error.log();
        error
    }

    pub fn from_io(operation: &'static str, error: io::Error) -> Self {
        let source = error.to_string();
        let code = classify_io(error.kind()).unwrap_or_else(|| classify(&source));
        let app_error = Self {
            code,
            message: specific_user_message(code, &source),
            retryable: is_retryable(code),
            operation: Some(operation.to_string()),
            detail: sanitize_diagnostic(&source),
        };
        app_error.log();
        app_error
    }

    fn log(&self) {
        warn!(
            code = self.code.as_str(),
            operation = self.operation.as_deref().unwrap_or(""),
            retryable = self.retryable,
            detail = self.detail.as_deref().unwrap_or(""),
            "command failed"
        );
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<String> for AppError {
    fn from(value: String) -> Self {
        let code = classify(&value);
        Self {
            code,
            message: specific_user_message(code, &value),
            retryable: is_retryable(code),
            operation: None,
            detail: sanitize_diagnostic(&value),
        }
    }
}

impl From<&str> for AppError {
    fn from(value: &str) -> Self {
        Self::from(value.to_string())
    }
}

impl From<io::Error> for AppError {
    fn from(error: io::Error) -> Self {
        let source = error.to_string();
        let code = classify_io(error.kind()).unwrap_or_else(|| classify(&source));
        Self {
            code,
            message: specific_user_message(code, &source),
            retryable: is_retryable(code),
            operation: None,
            detail: sanitize_diagnostic(&source),
        }
    }
}

pub fn user_message(code: AppErrorCode) -> &'static str {
    match code {
        AppErrorCode::Permission => "You don't have permission for this operation",
        AppErrorCode::MissingPath => "This file or folder is no longer available",
        AppErrorCode::Conflict => "A file or folder with this name already exists",
        AppErrorCode::Cancelled => "The operation was cancelled",
        AppErrorCode::HelperMissing => "A required helper is not available on this computer",
        AppErrorCode::RemoteUnavailable => "The remote drive is unavailable",
        AppErrorCode::InvalidName => "The name is not valid",
        AppErrorCode::InUse => "The file is in use by another program",
        AppErrorCode::DiskFull => "There is not enough disk space",
        AppErrorCode::Archive => "The archive could not be opened",
        AppErrorCode::Path => "The path is not valid",
        AppErrorCode::TypeMismatch => "This item is the wrong type for the operation",
        AppErrorCode::Unsupported => "This operation is not available here",
        AppErrorCode::Unknown => "Something went wrong",
    }
}

fn specific_user_message(code: AppErrorCode, source: &str) -> String {
    if is_actionable_user_message(source) {
        return source.trim().to_string();
    }
    let lower = source.to_ascii_lowercase();
    let message = match code {
        AppErrorCode::HelperMissing if lower.contains("ffmpeg") => {
            "FFmpeg is not installed on this computer"
        }
        AppErrorCode::HelperMissing
            if lower.contains("libreoffice") || lower.contains("soffice") =>
        {
            "LibreOffice is not installed on this computer"
        }
        AppErrorCode::HelperMissing
            if lower.contains("imagemagick") || lower.contains("magick") =>
        {
            "ImageMagick is not installed on this computer"
        }
        AppErrorCode::HelperMissing if lower.contains("winfsp") => {
            "WinFsp is not installed on this computer"
        }
        AppErrorCode::HelperMissing if lower.contains("rclone") => {
            "The bundled rclone helper is not available"
        }
        AppErrorCode::HelperMissing if lower.contains("helper") => {
            "The Remote Drives helper is not available"
        }
        AppErrorCode::Archive if lower.contains("password") => "Incorrect archive password",
        _ => user_message(code),
    };
    message.to_string()
}

fn is_actionable_user_message(source: &str) -> bool {
    let trimmed = source.trim();
    if trimmed.is_empty() || trimmed.len() > 200 || trimmed.contains('\n') {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("os error")
        || lower.contains("password=")
        || lower.contains("token=")
        || lower.contains("secret=")
        || trimmed.contains(":\\")
        || trimmed.contains("/Users/")
        || trimmed.contains("/home/")
    {
        return false;
    }
    lower.starts_with("install ")
        || lower.starts_with("approve ")
        || lower.starts_with("reinstall ")
        || lower.starts_with("enable ")
        || lower.starts_with("the bundled ")
}

fn is_retryable(code: AppErrorCode) -> bool {
    matches!(
        code,
        AppErrorCode::Cancelled
            | AppErrorCode::HelperMissing
            | AppErrorCode::RemoteUnavailable
            | AppErrorCode::InUse
            | AppErrorCode::DiskFull
    )
}

fn classify_io(kind: io::ErrorKind) -> Option<AppErrorCode> {
    match kind {
        io::ErrorKind::PermissionDenied => Some(AppErrorCode::Permission),
        io::ErrorKind::NotFound => Some(AppErrorCode::MissingPath),
        io::ErrorKind::AlreadyExists => Some(AppErrorCode::Conflict),
        io::ErrorKind::Interrupted => Some(AppErrorCode::Cancelled),
        io::ErrorKind::IsADirectory | io::ErrorKind::NotADirectory => {
            Some(AppErrorCode::TypeMismatch)
        }
        io::ErrorKind::StorageFull => Some(AppErrorCode::DiskFull),
        io::ErrorKind::ConnectionRefused
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::NotConnected
        | io::ErrorKind::TimedOut
        | io::ErrorKind::BrokenPipe
        | io::ErrorKind::UnexpectedEof => Some(AppErrorCode::RemoteUnavailable),
        _ => None,
    }
}

fn classify(source: &str) -> AppErrorCode {
    let lower = source.to_ascii_lowercase();

    if contains_any(
        &lower,
        &[
            "cancelled",
            "canceled",
            "interrupted",
            "file operation cancelled",
        ],
    ) {
        return AppErrorCode::Cancelled;
    }

    if contains_any(
        &lower,
        &[
            "install ffmpeg",
            "install libreoffice",
            "install imagemagick",
            "install winfsp",
            "bundled rclone",
            "bundled winfsp",
            "helper is only used",
            "helper settings",
            "approve the explorie",
            "remote drives helper",
            "privileged mount helper",
            "qlmanage",
            "preview provider is available",
        ],
    ) || (lower.contains("helper") && lower.contains("unavailable"))
        || (lower.contains("helper") && lower.contains("unable to"))
        || (lower.contains("winfsp")
            && (lower.contains("install") || lower.contains("unavailable")))
        || (lower.contains("ffmpeg") && lower.contains("install"))
        || (lower.contains("libreoffice") && lower.contains("install"))
        || (lower.contains("imagemagick") && lower.contains("install"))
    {
        return AppErrorCode::HelperMissing;
    }

    if contains_any(
        &lower,
        &[
            "rclone",
            "remote drive",
            "remote is no longer configured",
            "configured rclone remote",
            "winfsp before mounting",
            "timed out waiting for rclone",
            "network",
            "connection refused",
            "econnrefused",
            "host unreachable",
            "etimedout",
            "timed out",
        ],
    ) {
        return AppErrorCode::RemoteUnavailable;
    }

    if contains_any(
        &lower,
        &[
            "access is denied",
            "access denied",
            "permission denied",
            "eacces",
            "eperm",
            "readonly",
            "read-only",
            "read only",
            "operation not permitted",
            "refusing to",
        ],
    ) {
        return AppErrorCode::Permission;
    }

    if contains_any(
        &lower,
        &[
            "no such file",
            "cannot find",
            "not found",
            "os error 2",
            "os error 3",
            "enoent",
            "path does not exist",
            "file not found",
            "no longer exists",
            "could not find disk",
        ],
    ) {
        return AppErrorCode::MissingPath;
    }

    if contains_any(
        &lower,
        &[
            "already exists",
            "file exists",
            "eexist",
            "destination already exists",
            "name already exists",
            "occupied",
        ],
    ) {
        return AppErrorCode::Conflict;
    }

    if contains_any(
        &lower,
        &[
            "being used",
            "used by another process",
            "sharing violation",
            "ebusy",
            "locked",
            "elocked",
        ],
    ) {
        return AppErrorCode::InUse;
    }

    if contains_any(
        &lower,
        &[
            "disk full",
            "no space",
            "enospc",
            "not enough space",
            "quota exceeded",
        ],
    ) {
        return AppErrorCode::DiskFull;
    }

    if contains_any(
        &lower,
        &[
            "invalid file name",
            "invalid name",
            "illegal character",
            "name too long",
            "enametoolong",
            "file name cannot",
            "file name contains",
            "file name is reserved",
        ],
    ) {
        return AppErrorCode::InvalidName;
    }

    if contains_any(
        &lower,
        &[
            "invalid archive",
            "corrupted archive",
            "bad archive",
            "password",
            "unsupported format",
            "unknown format",
        ],
    ) {
        return AppErrorCode::Archive;
    }

    if contains_any(
        &lower,
        &[
            "not a directory",
            "enotdir",
            "is a directory",
            "eisdir",
            "wrong type",
        ],
    ) {
        return AppErrorCode::TypeMismatch;
    }

    if contains_any(
        &lower,
        &[
            "path too long",
            "pathname too long",
            "invalid path",
            "malformed path",
            "traversal",
            "must be absolute",
            "must be a real directory",
        ],
    ) {
        return AppErrorCode::Path;
    }

    if contains_any(
        &lower,
        &[
            "not supported",
            "only available",
            "only used",
            "unavailable on this platform",
            "currently available only",
            "currently support",
        ],
    ) {
        return AppErrorCode::Unsupported;
    }

    AppErrorCode::Unknown
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn sanitize_diagnostic(source: &str) -> Option<String> {
    let mut cleaned = source.replace(['\r', '\n'], " ");
    cleaned = redact_secrets(&cleaned);
    cleaned = strip_windows_paths(&cleaned);
    cleaned = strip_unix_paths(&cleaned);
    cleaned = cleaned.replace("(os error ", "(error ");
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.chars().take(240).collect())
    }
}

fn redact_secrets(input: &str) -> String {
    let mut output = input.to_string();
    for key in [
        "password",
        "passwd",
        "pwd",
        "token",
        "secret",
        "authorization",
        "rclone_rc_pass",
        "RCLONE_RC_PASS",
    ] {
        output = redact_key_value(&output, key);
    }
    redact_url_userinfo(&output)
}

fn redact_key_value(input: &str, key: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let lower = input.to_ascii_lowercase();
    let key_lower = key.to_ascii_lowercase();
    let mut i = 0;
    while i < input.len() {
        if let Some(rel) = lower[i..].find(&key_lower) {
            let start = i + rel;
            output.push_str(&input[i..start]);
            output.push_str(&input[start..start + key.len()]);
            let mut cursor = start + key.len();
            while cursor < input.len()
                && input[cursor..]
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_whitespace())
            {
                let ch = input[cursor..].chars().next().unwrap();
                output.push(ch);
                cursor += ch.len_utf8();
            }
            if input[cursor..].starts_with('=') || input[cursor..].starts_with(':') {
                output.push(input[cursor..].chars().next().unwrap());
                cursor += 1;
                while cursor < input.len()
                    && input[cursor..]
                        .chars()
                        .next()
                        .is_some_and(|ch| ch.is_whitespace())
                {
                    cursor += input[cursor..].chars().next().unwrap().len_utf8();
                }
                output.push_str("***");
                while cursor < input.len()
                    && input[cursor..]
                        .chars()
                        .next()
                        .is_some_and(|ch| !ch.is_whitespace())
                {
                    cursor += input[cursor..].chars().next().unwrap().len_utf8();
                }
                i = cursor;
                continue;
            }
            i = start + key.len();
            continue;
        }
        output.push_str(&input[i..]);
        break;
    }
    output
}

fn redact_url_userinfo(input: &str) -> String {
    if let Some(start) = input.find("://") {
        let after = start + 3;
        if let Some(at) = input[after..].find('@') {
            let creds = &input[after..after + at];
            if creds.contains(':') && !creds.contains('/') {
                return format!("{}://***:***@{}", &input[..start], &input[after + at + 1..]);
            }
        }
    }
    input.to_string()
}

fn strip_windows_paths(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_alphabetic()
            && i + 2 < bytes.len()
            && bytes[i + 1] == b':'
            && (bytes[i + 2] == b'\\' || bytes[i + 2] == b'/')
        {
            let start = i;
            i += 3;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'"' {
                i += 1;
            }
            let path = &input[start..i];
            output.push_str(path_leaf(path));
            continue;
        }
        output.push(input[i..].chars().next().unwrap_or('?'));
        i += input[i..]
            .chars()
            .next()
            .map(|ch| ch.len_utf8())
            .unwrap_or(1);
    }
    output
}

fn strip_unix_paths(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'/' && i + 1 < bytes.len() && !bytes[i + 1].is_ascii_whitespace() {
            let start = i;
            i += 1;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'"' {
                i += 1;
            }
            let path = &input[start..i];
            if path.matches('/').count() >= 1 {
                output.push_str(path_leaf(path));
                continue;
            }
            i = start;
        }
        output.push(input[i..].chars().next().unwrap_or('?'));
        i += input[i..]
            .chars()
            .next()
            .map(|ch| ch.len_utf8())
            .unwrap_or(1);
    }
    output
}

fn path_leaf(path: &str) -> &str {
    path.rsplit(['\\', '/'])
        .find(|part| !part.is_empty())
        .unwrap_or("path")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn payload_round_trips_through_json() {
        let error = AppError::from_raw(
            "connect_remote_drive",
            "Install WinFsp before mounting remote drives on Windows.",
        );
        let json = serde_json::to_string(&error).expect("serialize");
        let parsed: AppError = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.code, AppErrorCode::HelperMissing);
        assert_eq!(parsed.operation.as_deref(), Some("connect_remote_drive"));
        assert!(parsed.retryable);
        assert_eq!(parsed, error);
        assert!(json.contains("\"code\":\"helper_missing\""));
        assert!(json.contains("\"retryable\":true"));
        assert!(!json.to_ascii_lowercase().contains("c:\\"));
    }

    #[test]
    fn classifies_required_failure_kinds() {
        let cases = [
            (
                "Access is denied. (os error 5)",
                AppErrorCode::Permission,
                false,
            ),
            (
                "No such file or directory (os error 2)",
                AppErrorCode::MissingPath,
                false,
            ),
            (
                "destination already exists: C:\\Users\\oshtz\\secret.txt",
                AppErrorCode::Conflict,
                false,
            ),
            ("file operation cancelled", AppErrorCode::Cancelled, true),
            (
                "The bundled rclone executable is unavailable. Reinstall Explorie.",
                AppErrorCode::HelperMissing,
                true,
            ),
            (
                "rclone exited before the mount was ready: exit code: 1",
                AppErrorCode::RemoteUnavailable,
                true,
            ),
        ];

        for (source, code, retryable) in cases {
            let error = AppError::from_raw("list_files", source);
            assert_eq!(error.code, code, "{source}");
            assert_eq!(error.retryable, retryable, "{source}");
            assert!(!error.message.contains('\\'), "{}", error.message);
            assert!(!error.message.contains("/Users/"), "{}", error.message);
            assert!(!error.message.to_ascii_lowercase().contains("os error"));
        }
    }

    #[test]
    fn io_kinds_map_without_raw_paths_in_user_message() {
        let error = AppError::from_io(
            "rename_path",
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                r"Access is denied: C:\Users\oshtz\secret\budget.xlsx",
            ),
        );
        assert_eq!(error.code, AppErrorCode::Permission);
        assert_eq!(error.message, user_message(AppErrorCode::Permission));
        assert!(!error.message.contains("budget.xlsx"));
        if let Some(detail) = &error.detail {
            assert!(!detail.contains("C:\\Users\\oshtz"));
            assert!(detail.contains("budget.xlsx"));
        }
    }

    #[test]
    fn redacts_credentials_from_diagnostics() {
        let error = AppError::from_raw(
            "configure_rclone",
            "Failed to start rclone: password=hunter2 RCLONE_RC_PASS=abc token=xyz",
        );
        let detail = error.detail.expect("detail");
        assert!(!detail.contains("hunter2"));
        assert!(!detail.contains("abc"));
        assert!(!detail.contains("xyz"));
        assert_eq!(error.code, AppErrorCode::RemoteUnavailable);
    }

    #[test]
    fn keeps_actionable_helper_install_messages() {
        for source in [
            "Install LibreOffice to preview Office and OpenDocument files.",
            "Install FFmpeg to preview this video format.",
            "Install ImageMagick to preview this image format.",
        ] {
            let error = AppError::from_raw("generate_preview_artifact", source);
            assert_eq!(error.code, AppErrorCode::HelperMissing);
            assert_eq!(error.message, source);
            assert!(error.retryable);
        }
    }

    #[test]
    fn list_dir_failure_becomes_structured_missing_path() {
        let missing = Path::new("C:\\definitely-missing-explorie-app-error-test");
        let source = explorie_core::list_dir(missing).expect_err("missing path");
        let error = AppError::from_raw("list_files", source.to_string());
        let json = serde_json::to_value(&error).expect("json");
        assert_eq!(json["code"], "missing_path");
        assert_eq!(json["retryable"], false);
        assert_eq!(json["operation"], "list_files");
        assert_eq!(json["message"], user_message(AppErrorCode::MissingPath));
        assert!(
            !json["message"]
                .as_str()
                .unwrap()
                .contains("definitely-missing")
        );
    }
}
