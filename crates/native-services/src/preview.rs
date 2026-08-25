use crate::{
    BlockingTask, ErrorCode, HelperStatusEvent, ServiceContext, ServiceError, ServiceEvent,
    ServiceResult,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const MAX_TEXT_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;
const MAX_THUMBNAIL_ENTRIES: usize = 256;
const MAX_THUMBNAIL_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub text: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PreviewArtifact {
    pub kind: String,
    pub path: PathBuf,
    pub mime_type: String,
    pub tool: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperStatus {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    pub extensions: Vec<String>,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct PreviewService {
    context: ServiceContext,
}

impl PreviewService {
    pub(crate) fn new(context: ServiceContext) -> Self {
        Self { context }
    }

    pub fn read_text(&self, path: PathBuf, max_bytes: u64) -> BlockingTask<TextPreview> {
        self.context
            .spawn_blocking(move || read_text_preview(&path, max_bytes))
    }

    pub fn helper_status(&self) -> BlockingTask<Vec<HelperStatus>> {
        let context = self.context.clone();
        self.context.spawn_blocking(move || {
            let statuses = helper_statuses();
            for status in &statuses {
                context
                    .events()
                    .publish(ServiceEvent::HelperStatus(HelperStatusEvent {
                        helper: status.name.clone(),
                        status: status.clone(),
                    }));
            }
            Ok(statuses)
        })
    }

    pub fn clear_cache(&self) -> BlockingTask<()> {
        let directory = self.cache_dir();
        self.context.spawn_blocking(move || {
            if directory.exists() {
                fs::remove_dir_all(&directory).map_err(ServiceError::from)?;
            }
            fs::create_dir_all(&directory).map_err(ServiceError::from)
        })
    }

    pub fn file_icon(&self, path: PathBuf) -> BlockingTask<Option<PathBuf>> {
        let cache = self.cache_dir();
        self.context
            .spawn_blocking(move || get_file_icon(&path, &cache))
    }

    pub fn thumbnail(&self, path: PathBuf, max_size: u32) -> BlockingTask<Option<PathBuf>> {
        let cache = self.cache_dir();
        self.context
            .spawn_blocking(move || get_file_thumbnail(&path, max_size, &cache))
    }

    pub fn artifact(&self, path: PathBuf) -> BlockingTask<PreviewArtifact> {
        let cache = self.cache_dir();
        self.context
            .spawn_blocking(move || generate_preview_artifact(&path, &cache))
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.context.resources().cache_dir.join("preview")
    }
}

fn read_text_preview(path: &Path, max_bytes: u64) -> ServiceResult<TextPreview> {
    let limit = max_bytes.min(MAX_TEXT_PREVIEW_BYTES);
    let mut bytes = Vec::with_capacity(limit.min(128 * 1024) as usize);
    File::open(path)
        .map_err(ServiceError::from)?
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(ServiceError::from)?;
    let truncated = bytes.len() as u64 > limit;
    bytes.truncate(limit as usize);
    Ok(TextPreview {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

fn helper_statuses() -> Vec<HelperStatus> {
    [
        (
            "FFmpeg",
            &["ffmpeg"][..],
            "-version",
            vec![
                "mov", "avi", "mkv", "wmv", "mp4", "webm", "flv", "m2ts", "mts", "mpeg", "mpg",
                "3gp",
            ],
        ),
        (
            "LibreOffice",
            &["soffice", "libreoffice"][..],
            "--version",
            vec![
                "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
            ],
        ),
        (
            "ImageMagick",
            &["magick"][..],
            "--version",
            vec!["heic", "heif", "tif", "tiff", "psd"],
        ),
    ]
    .into_iter()
    .map(|(name, candidates, version_arg, extensions)| {
        let found = candidates.iter().find_map(|candidate| {
            let output = command(candidate).arg(version_arg).output().ok()?;
            output.status.success().then(|| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_string()
            })
        });
        match found {
            Some(version) => HelperStatus {
                name: name.to_string(),
                available: true,
                version: (!version.is_empty()).then_some(version),
                extensions: extensions.into_iter().map(String::from).collect(),
                error: None,
            },
            None => HelperStatus {
                name: name.to_string(),
                available: false,
                version: None,
                extensions: extensions.into_iter().map(String::from).collect(),
                error: Some(format!("{name} is unavailable")),
            },
        }
    })
    .collect()
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_external_document(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp" | "rtf"
    )
}

fn is_external_video(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "mov" | "avi" | "mkv" | "wmv" | "flv" | "m2ts" | "mts" | "mpeg" | "mpg" | "3gp"
    )
}

fn is_external_image(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "heic" | "heif" | "tif" | "tiff" | "psd"
    )
}

fn cache_key(path: &Path, suffix: &str) -> String {
    let metadata = fs::metadata(path).ok();
    let mut digest = Sha256::new();
    digest.update(path.to_string_lossy().as_bytes());
    if let Some(metadata) = metadata {
        digest.update(metadata.len().to_le_bytes());
        if let Ok(modified) = metadata.modified()
            && let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH)
        {
            digest.update(duration.as_secs().to_le_bytes());
            digest.update(duration.subsec_nanos().to_le_bytes());
        }
    }
    format!("{}-{suffix}", hex_digest(digest.finalize()))
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn cache_output(cache: &Path, path: &Path, suffix: &str, extension: &str) -> PathBuf {
    cache.join(format!("{}-{suffix}.{extension}", cache_key(path, suffix)))
}

fn get_file_icon(path: &Path, cache: &Path) -> ServiceResult<Option<PathBuf>> {
    #[cfg(windows)]
    {
        if !path.is_file() || !matches!(extension(path).as_str(), "exe" | "lnk") {
            return Ok(None);
        }
        let output = cache_output(cache, path, "icon", "png");
        if output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
            return Ok(Some(output));
        }
        fs::create_dir_all(cache).map_err(ServiceError::from)?;
        let script = r#"Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:EXPLORIE_ICON_INPUT)
if ($null -eq $icon) { exit 2 }
try { $bitmap = $icon.ToBitmap(); try { $bitmap.Save($env:EXPLORIE_ICON_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() } } finally { $icon.Dispose() }"#;
        let status = command("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ])
            .env("EXPLORIE_ICON_INPUT", path)
            .env("EXPLORIE_ICON_OUTPUT", &output)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| ServiceError::new(ErrorCode::HelperMissing, error.to_string()))?;
        if status.success() && output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
            Ok(Some(output))
        } else {
            let _ = fs::remove_file(output);
            Ok(None)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (path, cache);
        Ok(None)
    }
}

fn get_file_thumbnail(path: &Path, max_size: u32, cache: &Path) -> ServiceResult<Option<PathBuf>> {
    if !path.is_file() {
        return Ok(None);
    }
    let is_image = matches!(
        extension(path).as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "tif" | "tiff"
    );
    let is_video = matches!(
        extension(path).as_str(),
        "mp4"
            | "webm"
            | "m4v"
            | "mov"
            | "avi"
            | "mkv"
            | "wmv"
            | "flv"
            | "m2ts"
            | "mts"
            | "mpeg"
            | "mpg"
            | "3gp"
    );
    if !is_image && !is_video {
        return Ok(None);
    }
    let max_size = max_size.clamp(64, 512);
    let output = cache_output(cache, path, &format!("thumbnail-{max_size}"), "png");
    if output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
        return Ok(Some(output));
    }
    fs::create_dir_all(cache).map_err(ServiceError::from)?;
    if is_image {
        generate_native_thumbnail(path, &output, max_size)?;
    } else {
        generate_video_thumbnail(path, &output, max_size)?;
    }
    if !output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
        return Err(ServiceError::new(
            ErrorCode::Internal,
            "Native thumbnailer produced an empty image",
        ));
    }
    prune_thumbnail_cache(cache);
    Ok(Some(output))
}

#[cfg(windows)]
fn generate_native_thumbnail(input: &Path, output: &Path, max_size: u32) -> ServiceResult<()> {
    let script = r#"Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($env:EXPLORIE_THUMB_INPUT)
try { $scale = [Math]::Min(1.0, [Math]::Min($env:EXPLORIE_THUMB_SIZE / $image.Width, $env:EXPLORIE_THUMB_SIZE / $image.Height)); $width = [Math]::Max(1, [int]($image.Width * $scale)); $height = [Math]::Max(1, [int]($image.Height * $scale)); $bitmap = New-Object System.Drawing.Bitmap($width, $height); try { $graphics = [System.Drawing.Graphics]::FromImage($bitmap); try { $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $graphics.DrawImage($image, 0, 0, $width, $height) } finally { $graphics.Dispose() }; $bitmap.Save($env:EXPLORIE_THUMB_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() } } finally { $image.Dispose() }"#;
    let status = command("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .env("EXPLORIE_THUMB_INPUT", input)
        .env("EXPLORIE_THUMB_OUTPUT", output)
        .env("EXPLORIE_THUMB_SIZE", max_size.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| ServiceError::new(ErrorCode::HelperMissing, error.to_string()))?;
    status.success().then_some(()).ok_or_else(|| {
        ServiceError::new(ErrorCode::Internal, "Windows could not decode this image")
    })
}

#[cfg(target_os = "macos")]
fn generate_native_thumbnail(input: &Path, output: &Path, max_size: u32) -> ServiceResult<()> {
    let status = command("sips")
        .args(["-s", "format", "png", "-Z"])
        .arg(max_size.to_string())
        .arg(input)
        .arg("--out")
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| ServiceError::new(ErrorCode::HelperMissing, error.to_string()))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| ServiceError::new(ErrorCode::Internal, "macOS could not decode this image"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn generate_native_thumbnail(_input: &Path, _output: &Path, _max_size: u32) -> ServiceResult<()> {
    Err(ServiceError::new(
        ErrorCode::Unsupported,
        "Native thumbnails are unavailable on this platform",
    ))
}

fn generate_video_thumbnail(input: &Path, output: &Path, max_size: u32) -> ServiceResult<()> {
    let tool = first_available_tool(&["ffmpeg"], "-version").ok_or_else(|| {
        ServiceError::new(
            ErrorCode::HelperMissing,
            "Install FFmpeg to generate video thumbnails.",
        )
    })?;
    let filter =
        format!("thumbnail,scale={max_size}:{max_size}:force_original_aspect_ratio=decrease");
    let status = command(&tool)
        .args(["-y", "-i"])
        .arg(input)
        .args(["-frames:v", "1", "-vf", &filter])
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| ServiceError::new(ErrorCode::HelperMissing, error.to_string()))?;
    status.success().then_some(()).ok_or_else(|| {
        ServiceError::new(
            ErrorCode::Internal,
            "FFmpeg could not generate a video thumbnail",
        )
    })
}

fn prune_thumbnail_cache(cache: &Path) {
    let Ok(entries) = fs::read_dir(cache) else {
        return;
    };
    let mut cached: Vec<(PathBuf, std::time::SystemTime, u64)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            if !name.to_string_lossy().contains("-thumbnail-") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((
                entry.path(),
                metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                metadata.len(),
            ))
        })
        .collect();
    cached.sort_by_key(|(_, modified, _)| *modified);
    let mut total = cached.iter().map(|(_, _, size)| *size).sum::<u64>();
    while cached.len() > MAX_THUMBNAIL_ENTRIES || total > MAX_THUMBNAIL_BYTES {
        let (path, _, size) = cached.remove(0);
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn generate_preview_artifact(path: &Path, cache: &Path) -> ServiceResult<PreviewArtifact> {
    if !path.exists() {
        return Err(ServiceError::new(ErrorCode::NotFound, "File not found."));
    }
    if is_external_document(path) {
        return convert_document_preview(path, cache);
    }
    if is_external_video(path) {
        return convert_video_preview(path, cache);
    }
    if is_external_image(path) {
        return convert_image_preview(path, cache);
    }
    Err(ServiceError::new(
        ErrorCode::Unsupported,
        "No external preview provider is available for this file type.",
    ))
}

fn first_available_tool(candidates: &[&str], version_arg: &str) -> Option<String> {
    candidates.iter().find_map(|candidate| {
        let status = command(candidate)
            .arg(version_arg)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()?;
        status.success().then(|| (*candidate).to_string())
    })
}

fn convert_document_preview(path: &Path, cache: &Path) -> ServiceResult<PreviewArtifact> {
    let tool = first_available_tool(&["soffice", "libreoffice"], "--version").ok_or_else(|| {
        ServiceError::new(
            ErrorCode::HelperMissing,
            "Install LibreOffice to preview Office and OpenDocument files.",
        )
    })?;
    fs::create_dir_all(cache).map_err(ServiceError::from)?;
    let output = cache_output(cache, path, "document", "pdf");
    let status = command(&tool)
        .args(["--headless", "--convert-to", "pdf", "--outdir"])
        .arg(cache)
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| ServiceError::new(ErrorCode::HelperMissing, error.to_string()))?;
    if !status.success() {
        return Err(ServiceError::new(
            ErrorCode::Internal,
            "LibreOffice could not convert this document for preview.",
        ));
    }
    let produced = cache.join(format!(
        "{}.pdf",
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("preview")
    ));
    if produced != output && produced.exists() {
        fs::rename(&produced, &output).map_err(ServiceError::from)?;
    }
    if !output.exists() {
        return Err(ServiceError::new(
            ErrorCode::Internal,
            "LibreOffice finished without producing a PDF preview.",
        ));
    }
    Ok(PreviewArtifact {
        kind: "pdf".into(),
        path: output,
        mime_type: "application/pdf".into(),
        tool,
    })
}

fn convert_video_preview(path: &Path, cache: &Path) -> ServiceResult<PreviewArtifact> {
    let tool = first_available_tool(&["ffmpeg"], "-version").ok_or_else(|| {
        ServiceError::new(
            ErrorCode::HelperMissing,
            "Install FFmpeg to preview this video format.",
        )
    })?;
    fs::create_dir_all(cache).map_err(ServiceError::from)?;
    let output = cache_output(cache, path, "video", "png");
    let status = command(&tool)
        .args(["-y", "-i"])
        .arg(path)
        .args(["-frames:v", "1", "-vf", "thumbnail,scale=1280:-1"])
        .arg(&output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| ServiceError::new(ErrorCode::HelperMissing, error.to_string()))?;
    if !status.success() || !output.exists() {
        return Err(ServiceError::new(
            ErrorCode::Internal,
            "FFmpeg could not generate a thumbnail for this video.",
        ));
    }
    Ok(PreviewArtifact {
        kind: "image".into(),
        path: output,
        mime_type: "image/png".into(),
        tool,
    })
}

fn convert_image_preview(path: &Path, cache: &Path) -> ServiceResult<PreviewArtifact> {
    let tool = first_available_tool(&["magick"], "--version").ok_or_else(|| {
        ServiceError::new(
            ErrorCode::HelperMissing,
            "Install ImageMagick to preview this image format.",
        )
    })?;
    fs::create_dir_all(cache).map_err(ServiceError::from)?;
    let output = cache_output(cache, path, "image", "png");
    let input = if extension(path) == "psd" {
        format!("{}[0]", path.to_string_lossy())
    } else {
        path.to_string_lossy().into_owned()
    };
    let status = command(&tool)
        .arg(input)
        .arg(&output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| ServiceError::new(ErrorCode::HelperMissing, error.to_string()))?;
    if !status.success() || !output.exists() {
        return Err(ServiceError::new(
            ErrorCode::Internal,
            "ImageMagick could not convert this image for preview.",
        ));
    }
    Ok(PreviewArtifact {
        kind: "image".into(),
        path: output,
        mime_type: "image/png".into(),
        tool,
    })
}

fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ResourcePaths;
    use std::io::Write;

    #[test]
    fn text_preview_is_bounded_and_reports_truncation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("large.txt");
        File::create(&path).unwrap().write_all(b"abcdef").unwrap();
        let service = PreviewService::new(ServiceContext::new(ResourcePaths::test(temp.path())));
        let preview = service.read_text(path, 4).wait().unwrap();
        assert_eq!(preview.text, "abcd");
        assert!(preview.truncated);
    }

    #[test]
    fn cache_is_injected_and_clear_does_not_touch_sources() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.txt");
        fs::write(&source, "keep").unwrap();
        let service = PreviewService::new(ServiceContext::new(ResourcePaths::test(temp.path())));
        fs::create_dir_all(service.cache_dir()).unwrap();
        fs::write(service.cache_dir().join("artifact"), "cache").unwrap();
        service.clear_cache().wait().unwrap();
        assert_eq!(fs::read_to_string(source).unwrap(), "keep");
        assert!(service.cache_dir().is_dir());
    }

    #[test]
    fn external_extensions_have_named_routes() {
        assert!(is_external_document(Path::new("file.docx")));
        assert!(is_external_video(Path::new("file.mkv")));
        assert!(is_external_image(Path::new("file.heic")));
        assert!(!is_external_image(Path::new("file.png")));
    }
}
