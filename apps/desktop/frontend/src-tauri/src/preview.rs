use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PreviewArtifact {
    pub kind: String,
    pub path: String,
    pub mime_type: String,
    pub tool: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PreviewHelperStatus {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    pub extensions: Vec<String>,
    pub install_hint: String,
}

const FFMPEG_EXTENSIONS: &[&str] = &[
    "MOV", "AVI", "MKV", "WMV", "FLV", "M2TS", "MTS", "MPEG", "MPG", "3GP",
];
const LIBREOFFICE_EXTENSIONS: &[&str] = &[
    "DOC", "DOCX", "XLS", "XLSX", "PPT", "PPTX", "ODT", "ODS", "ODP", "RTF",
];
const IMAGEMAGICK_EXTENSIONS: &[&str] = &["HEIC", "HEIF", "TIF", "TIFF", "PSD"];

pub fn preview_cache_dir(app_cache_dir: &Path) -> PathBuf {
    app_cache_dir.join("preview")
}

pub fn resolve_app_preview_cache(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| preview_cache_dir(&dir))
        .map_err(|_| "Could not resolve the app preview cache.".to_string())
}

pub fn is_external_document_preview(path: &Path) -> bool {
    matches!(
        path_extension_lower(path).as_str(),
        "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp" | "rtf"
    )
}

pub fn is_external_video_preview(path: &Path) -> bool {
    matches!(
        path_extension_lower(path).as_str(),
        "mov" | "avi" | "mkv" | "wmv" | "flv" | "m2ts" | "mts" | "mpeg" | "mpg" | "3gp"
    )
}

pub fn is_external_image_preview(path: &Path) -> bool {
    matches!(
        path_extension_lower(path).as_str(),
        "heic" | "heif" | "tif" | "tiff" | "psd"
    )
}

pub fn preview_helper_status() -> Vec<PreviewHelperStatus> {
    vec![
        detect_preview_helper(
            "ffmpeg",
            "FFmpeg",
            &["ffmpeg"],
            &["-version"],
            FFMPEG_EXTENSIONS,
        ),
        detect_preview_helper(
            "libreoffice",
            "LibreOffice",
            &["soffice", "libreoffice"],
            &["--version"],
            LIBREOFFICE_EXTENSIONS,
        ),
        detect_preview_helper(
            "imagemagick",
            "ImageMagick",
            &["magick"],
            &["--version", "-version"],
            IMAGEMAGICK_EXTENSIONS,
        ),
    ]
}

pub fn generate_preview_artifact(path: &Path, cache_dir: &Path) -> Result<PreviewArtifact, String> {
    if !path.is_file() {
        return Err("This file is no longer available.".to_string());
    }

    if is_external_document_preview(path) {
        return convert_document_preview(path, cache_dir);
    }
    if is_external_video_preview(path) {
        return convert_video_preview(path, cache_dir);
    }
    if is_external_image_preview(path) {
        return convert_image_preview(path, cache_dir);
    }

    Err("No external preview provider is available for this file type.".to_string())
}

pub fn clear_preview_cache(cache_dir: &Path) -> Result<(), String> {
    if cache_dir.file_name().and_then(|name| name.to_str()) != Some("preview") {
        return Err("Refusing to clear a path that is not the preview cache.".to_string());
    }
    if cache_dir.exists() {
        std::fs::remove_dir_all(cache_dir)
            .map_err(|_| "Could not clear the preview cache.".to_string())?;
    }
    Ok(())
}

pub fn preview_cache_output_path(cache_dir: &Path, path: &Path, output_ext: &str) -> PathBuf {
    cache_dir.join(format!(
        "{}-{:016x}.{}",
        sanitize_preview_stem(path),
        source_identity_hash(path),
        output_ext
    ))
}

pub fn missing_helper_message(id: &str) -> String {
    match id {
        "ffmpeg" => format!(
            "Install FFmpeg to preview this video format. {}. Then retry this preview.",
            ffmpeg_install_hint()
        ),
        "libreoffice" => format!(
            "Install LibreOffice to preview Office and OpenDocument files. {}. Then retry this preview.",
            libreoffice_install_hint()
        ),
        "imagemagick" => format!(
            "Install ImageMagick to preview HEIC, TIFF, or PSD files. {}. Then retry this preview.",
            imagemagick_install_hint()
        ),
        _ => "A required preview helper is not installed. Check Settings, then retry.".to_string(),
    }
}

pub fn failed_helper_message(id: &str) -> String {
    match id {
        "ffmpeg" => {
            "FFmpeg could not generate a preview for this video. Retry, or check Settings for helper status."
                .to_string()
        }
        "libreoffice" => {
            "LibreOffice could not convert this document for preview. Retry, or check Settings for helper status."
                .to_string()
        }
        "imagemagick" => {
            "ImageMagick could not convert this image for preview. Retry, or check Settings for helper status."
                .to_string()
        }
        _ => "The preview helper failed. Retry, or check Settings.".to_string(),
    }
}

fn ffmpeg_install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "Install it with Homebrew: brew install ffmpeg"
    } else if cfg!(target_os = "windows") {
        "Install it with winget: winget install ffmpeg"
    } else {
        "Install it with your package manager"
    }
}

fn libreoffice_install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "Install it with Homebrew: brew install --cask libreoffice"
    } else if cfg!(target_os = "windows") {
        "Install it from libreoffice.org"
    } else {
        "Install it with your package manager"
    }
}

fn imagemagick_install_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "Install it with Homebrew: brew install imagemagick"
    } else if cfg!(target_os = "windows") {
        "Install it with winget: winget install ImageMagick.ImageMagick"
    } else {
        "Install it with your package manager"
    }
}

fn detect_preview_helper(
    id: &str,
    name: &str,
    candidates: &[&str],
    version_args: &[&str],
    extensions: &[&str],
) -> PreviewHelperStatus {
    let version = probe_helper_version(candidates, version_args);
    PreviewHelperStatus {
        id: id.to_string(),
        name: name.to_string(),
        available: version.is_some(),
        version,
        extensions: extensions
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        install_hint: helper_install_hint(id),
    }
}

fn helper_install_hint(id: &str) -> String {
    match id {
        "ffmpeg" => ffmpeg_install_hint().to_string(),
        "libreoffice" => libreoffice_install_hint().to_string(),
        "imagemagick" => imagemagick_install_hint().to_string(),
        _ => "Install the helper listed in Settings, then retry.".to_string(),
    }
}

fn helper_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn probe_helper_version(candidates: &[&str], version_args: &[&str]) -> Option<String> {
    for candidate in candidates {
        for arg in version_args {
            let Ok(output) = helper_command(candidate).arg(*arg).output() else {
                continue;
            };
            if !output.status.success() {
                continue;
            }
            let text = if output.stdout.iter().any(|byte| !byte.is_ascii_whitespace()) {
                String::from_utf8_lossy(&output.stdout)
            } else {
                String::from_utf8_lossy(&output.stderr)
            };
            if let Some(line) = text.lines().map(str::trim).find(|line| !line.is_empty()) {
                return Some(truncate_version(line));
            }
        }
    }
    None
}

fn first_available_tool(candidates: &[&str], version_arg: &str) -> Option<String> {
    candidates.iter().find_map(|candidate| {
        let status = helper_command(candidate)
            .arg(version_arg)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()?;
        status.success().then(|| (*candidate).to_string())
    })
}

fn convert_document_preview(path: &Path, cache_dir: &Path) -> Result<PreviewArtifact, String> {
    let tool = first_available_tool(&["soffice", "libreoffice"], "--version")
        .ok_or_else(|| missing_helper_message("libreoffice"))?;
    std::fs::create_dir_all(cache_dir)
        .map_err(|_| "Could not create the preview cache.".to_string())?;

    let produced = preview_cache_output_path(cache_dir, path, "pdf");
    if produced.metadata().is_ok_and(|metadata| metadata.len() > 0) {
        return Ok(document_artifact(produced, tool));
    }

    let status = helper_command(&tool)
        .args(["--headless", "--convert-to", "pdf", "--outdir"])
        .arg(cache_dir)
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| failed_helper_message("libreoffice"))?;

    if !status.success() {
        return Err(failed_helper_message("libreoffice"));
    }

    let office_default = cache_dir.join(format!(
        "{}.pdf",
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("preview")
    ));

    let final_path = if office_default.exists() && office_default != produced {
        let _ = std::fs::remove_file(&produced);
        std::fs::rename(&office_default, &produced)
            .map_err(|_| "Could not store the generated document preview.".to_string())?;
        produced
    } else if produced.exists() {
        produced
    } else {
        return Err(failed_helper_message("libreoffice"));
    };

    Ok(document_artifact(final_path, tool))
}

fn convert_video_preview(path: &Path, cache_dir: &Path) -> Result<PreviewArtifact, String> {
    let tool = first_available_tool(&["ffmpeg"], "-version")
        .ok_or_else(|| missing_helper_message("ffmpeg"))?;
    std::fs::create_dir_all(cache_dir)
        .map_err(|_| "Could not create the preview cache.".to_string())?;

    let output = preview_cache_output_path(cache_dir, path, "png");
    if output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
        return Ok(image_artifact(output, tool));
    }

    let status = helper_command(&tool)
        .args(["-y", "-i"])
        .arg(path)
        .args(["-frames:v", "1", "-vf", "thumbnail,scale=1280:-1"])
        .arg(&output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| failed_helper_message("ffmpeg"))?;

    if !status.success() || !output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
        let _ = std::fs::remove_file(&output);
        return Err(failed_helper_message("ffmpeg"));
    }

    Ok(image_artifact(output, tool))
}

fn convert_image_preview(path: &Path, cache_dir: &Path) -> Result<PreviewArtifact, String> {
    let tool = first_available_tool(&["magick"], "--version")
        .or_else(|| first_available_tool(&["magick"], "-version"))
        .ok_or_else(|| missing_helper_message("imagemagick"))?;
    std::fs::create_dir_all(cache_dir)
        .map_err(|_| "Could not create the preview cache.".to_string())?;

    let output = preview_cache_output_path(cache_dir, path, "png");
    if output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
        return Ok(image_artifact(output, tool));
    }

    let input = if path_extension_lower(path) == "psd" {
        format!("{}[0]", path.to_string_lossy())
    } else {
        path.to_string_lossy().to_string()
    };
    let status = helper_command(&tool)
        .arg(input)
        .arg(&output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| failed_helper_message("imagemagick"))?;

    if !status.success() || !output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
        let _ = std::fs::remove_file(&output);
        return Err(failed_helper_message("imagemagick"));
    }

    Ok(image_artifact(output, tool))
}

fn document_artifact(path: PathBuf, tool: String) -> PreviewArtifact {
    PreviewArtifact {
        kind: "pdf".to_string(),
        path: path.to_string_lossy().to_string(),
        mime_type: "application/pdf".to_string(),
        tool,
    }
}

fn image_artifact(path: PathBuf, tool: String) -> PreviewArtifact {
    PreviewArtifact {
        kind: "image".to_string(),
        path: path.to_string_lossy().to_string(),
        mime_type: "image/png".to_string(),
        tool,
    }
}

fn path_extension_lower(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn sanitize_preview_stem(path: &Path) -> String {
    let raw = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("preview");
    let safe: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = safe.trim_matches('_');
    if trimmed.is_empty() {
        "preview".to_string()
    } else {
        trimmed.to_string()
    }
}

fn source_identity_hash(path: &Path) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    if let Ok(metadata) = path.metadata() {
        metadata.len().hash(&mut hasher);
        metadata.modified().ok().hash(&mut hasher);
    }
    hasher.finish()
}

fn truncate_version(value: &str) -> String {
    const MAX_LEN: usize = 96;
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_LEN {
        return trimmed.to_string();
    }
    let mut truncated: String = trimmed.chars().take(MAX_LEN.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "explorie-preview-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn helper_status_reports_availability_version_and_coverage() {
        let status = preview_helper_status();
        assert_eq!(status.len(), 3);
        assert_eq!(status[0].id, "ffmpeg");
        assert_eq!(status[0].name, "FFmpeg");
        assert_eq!(status[0].extensions, FFMPEG_EXTENSIONS);
        assert_eq!(status[1].id, "libreoffice");
        assert_eq!(status[1].extensions, LIBREOFFICE_EXTENSIONS);
        assert_eq!(status[2].id, "imagemagick");
        assert_eq!(status[2].extensions, IMAGEMAGICK_EXTENSIONS);
        for helper in &status {
            assert_eq!(helper.available, helper.version.is_some());
            assert!(!helper.install_hint.is_empty());
            if let Some(version) = &helper.version {
                assert!(!version.is_empty());
                assert!(version.chars().count() <= 96);
            }
        }
    }

    #[test]
    fn helper_messages_name_the_next_action_without_subprocess_noise() {
        for id in ["ffmpeg", "libreoffice", "imagemagick"] {
            let missing = missing_helper_message(id);
            let failed = failed_helper_message(id);
            assert!(missing.to_lowercase().contains("install"));
            assert!(missing.to_lowercase().contains("retry"));
            assert!(failed.to_lowercase().contains("retry"));
            assert!(!missing.contains("os error"));
            assert!(!failed.contains("stderr"));
        }
    }

    #[test]
    fn cache_output_changes_when_source_identity_changes() {
        let temp = TestDir::new();
        let cache = preview_cache_dir(&temp.0.join("app-cache"));
        let source = temp.0.join("clip.avi");
        fs::write(&source, b"one").unwrap();
        let first = preview_cache_output_path(&cache, &source, "png");
        fs::write(&source, b"changed-identity").unwrap();
        let second = preview_cache_output_path(&cache, &source, "png");
        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(cache.as_path()));
        assert!(
            first
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("clip-")
        );
        assert!(first.extension().unwrap() == "png");
    }

    #[test]
    fn cache_output_stays_under_app_preview_cache_and_sanitizes_names() {
        let cache =
            PathBuf::from("C:/Users/USER/AppData/Local/com.omershatz.explorie/cache/preview");
        let path =
            preview_cache_output_path(&cache, Path::new("C:/docs/Quarterly Report.docx"), "pdf");
        let rendered = path.to_string_lossy();
        assert!(rendered.contains("preview"));
        assert!(rendered.contains("Quarterly_Report-"));
        assert!(rendered.ends_with(".pdf"));
        assert!(!rendered.contains("Quarterly Report"));
    }

    #[test]
    fn clear_preview_cache_removes_only_the_preview_directory() {
        let temp = TestDir::new();
        let app_cache = temp.0.join("app-cache");
        let preview = preview_cache_dir(&app_cache);
        let source = temp.0.join("report.docx");
        let metadata = temp.0.join(".explorie.json");
        fs::create_dir_all(&preview).unwrap();
        fs::write(preview.join("artifact.pdf"), b"cached").unwrap();
        fs::write(&source, b"source").unwrap();
        fs::write(&metadata, b"{\"schema\":{}}").unwrap();

        clear_preview_cache(&preview).unwrap();

        assert!(!preview.exists());
        assert!(source.exists());
        assert!(metadata.exists());
        assert_eq!(fs::read(&source).unwrap(), b"source");
    }

    #[test]
    fn clear_preview_cache_refuses_source_directories() {
        let temp = TestDir::new();
        let photos = temp.0.join("photos");
        fs::create_dir_all(&photos).unwrap();
        let photo = photos.join("a.jpg");
        fs::write(&photo, b"image").unwrap();

        assert!(clear_preview_cache(&photos).is_err());
        assert!(photo.exists());
    }

    #[test]
    fn generate_preview_rejects_unsupported_types_without_helpers() {
        let temp = TestDir::new();
        let file = temp.0.join("note.txt");
        fs::write(&file, b"hello").unwrap();
        let error = generate_preview_artifact(&file, &preview_cache_dir(&temp.0)).unwrap_err();
        assert!(error.contains("No external preview provider"));
    }

    #[test]
    fn generate_preview_explains_missing_helpers() {
        let temp = TestDir::new();
        let cache = preview_cache_dir(&temp.0.join("app-cache"));

        if first_available_tool(&["ffmpeg"], "-version").is_none() {
            let video = temp.0.join("clip.avi");
            fs::write(&video, b"not-a-video").unwrap();
            let error = generate_preview_artifact(&video, &cache).unwrap_err();
            assert!(error.contains("FFmpeg"));
            assert!(error.to_lowercase().contains("retry"));
            assert!(!error.to_lowercase().contains("os error"));
        }

        if first_available_tool(&["soffice", "libreoffice"], "--version").is_none() {
            let document = temp.0.join("report.docx");
            fs::write(&document, b"not-office").unwrap();
            let error = generate_preview_artifact(&document, &cache).unwrap_err();
            assert!(error.contains("LibreOffice"));
            assert!(error.to_lowercase().contains("retry"));
        }

        if first_available_tool(&["magick"], "--version").is_none()
            && first_available_tool(&["magick"], "-version").is_none()
        {
            let image = temp.0.join("photo.heic");
            fs::write(&image, b"not-heic").unwrap();
            let error = generate_preview_artifact(&image, &cache).unwrap_err();
            assert!(error.contains("ImageMagick"));
            assert!(error.to_lowercase().contains("retry"));
        }
    }
}
