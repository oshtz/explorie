use crate::{
    BlockingTask, ErrorCode, HelperStatusEvent, ServiceContext, ServiceError, ServiceEvent,
    ServiceResult,
};
use crate::{ImageMetadata, image_metadata};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use syntect::easy::ScopeRegionIterator;
use syntect::parsing::{ParseState, ScopeStack, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

const MAX_TEXT_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TEXT_HIGHLIGHTS: usize = 50_000;
const MAX_ICON_CACHE_ENTRIES: usize = 256;
const MAX_ICON_CACHE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_THUMBNAIL_ENTRIES: usize = 256;
const MAX_THUMBNAIL_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PDF_CACHE_ENTRIES: usize = 48;
const MAX_PDF_CACHE_BYTES: u64 = 256 * 1024 * 1024;
const PDF_RENDER_SCALE: f32 = 1.5;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub text: String,
    pub truncated: bool,
    pub language: Option<String>,
    pub wrapped: bool,
    pub highlights: Vec<TextHighlight>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextHighlightKind {
    Comment,
    String,
    Number,
    Keyword,
    Function,
    Type,
    Variable,
    Constant,
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextHighlight {
    pub start: usize,
    pub end: usize,
    pub kind: TextHighlightKind,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PreviewArtifact {
    pub kind: String,
    pub path: PathBuf,
    pub mime_type: String,
    pub tool: String,
}

/// One locally rasterized PDF page. The file path points into the injected
/// preview cache; source bytes never cross the native UI boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPagePreview {
    pub source_path: PathBuf,
    pub image_path: PathBuf,
    pub page_index: usize,
    pub page_count: usize,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub display_width: u32,
    pub display_height: u32,
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

    pub fn pdf_page(&self, path: PathBuf, page_index: usize) -> BlockingTask<PdfPagePreview> {
        let cache = self.cache_dir();
        self.context
            .spawn_blocking(move || render_pdf_page(&path, page_index, &cache))
    }

    pub fn image_metadata(&self, path: PathBuf) -> BlockingTask<ImageMetadata> {
        self.context
            .spawn_blocking(move || image_metadata::load_image_metadata(&path))
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
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let (language, highlights) = highlight_text(path, &text);
    Ok(TextPreview {
        text,
        truncated,
        language,
        wrapped: matches!(
            path.extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str(),
            "md" | "markdown"
        ),
        highlights,
    })
}

fn syntax_set() -> &'static SyntaxSet {
    static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
    SYNTAX_SET.get_or_init(two_face::syntax::extra_newlines)
}

fn highlight_text(path: &Path, text: &str) -> (Option<String>, Vec<TextHighlight>) {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "txt" | "log" | "csv") {
        return (None, Vec::new());
    }

    let syntaxes = syntax_set();
    let Some(syntax) = find_syntax(syntaxes, &extension) else {
        return (None, Vec::new());
    };
    if syntax.name == "Plain Text" {
        return (None, Vec::new());
    }

    let mut parser = ParseState::new(syntax);
    let mut scopes = ScopeStack::new();
    let mut highlights = Vec::<TextHighlight>::new();
    let mut offset = 0usize;

    for line in LinesWithEndings::from(text) {
        let Ok(operations) = parser.parse_line(line, syntaxes) else {
            break;
        };
        for (region, operation) in ScopeRegionIterator::new(&operations, line) {
            if scopes.apply(operation).is_err() {
                return (Some(syntax.name.clone()), highlights);
            }
            let start = offset;
            offset = offset.saturating_add(region.len());
            let Some(kind) = highlight_kind(&scopes) else {
                continue;
            };
            if let Some(previous) = highlights.last_mut()
                && previous.end == start
                && previous.kind == kind
            {
                previous.end = offset;
            } else if highlights.len() < MAX_TEXT_HIGHLIGHTS {
                highlights.push(TextHighlight {
                    start,
                    end: offset,
                    kind,
                });
            } else {
                return (Some(syntax.name.clone()), highlights);
            }
        }
    }

    (Some(syntax.name.clone()), highlights)
}

fn find_syntax<'a>(syntaxes: &'a SyntaxSet, extension: &str) -> Option<&'a SyntaxReference> {
    syntaxes.find_syntax_by_extension(extension).or_else(|| {
        let aliases: &[&str] = match extension {
            "json5" | "jsonc" => &["json"],
            "tsx" => &["ts", "js"],
            "jsx" | "mjs" | "cjs" => &["js"],
            "pyw" => &["py"],
            "csharp" => &["cs"],
            "htm" => &["html"],
            "scss" | "sass" => &["css"],
            "cxx" | "cc" | "hpp" | "hh" => &["cpp"],
            "kts" => &["kt"],
            "bash" | "zsh" => &["sh"],
            "toml" | "lock" => &["ini"],
            "psm1" => &["ps1"],
            _ => &[],
        };
        aliases
            .iter()
            .find_map(|alias| syntaxes.find_syntax_by_extension(alias))
    })
}

fn highlight_kind(scopes: &ScopeStack) -> Option<TextHighlightKind> {
    let scopes = scopes
        .as_slice()
        .iter()
        .map(|scope| scope.build_string())
        .collect::<Vec<_>>()
        .join(" ");
    if scopes.contains("invalid") {
        Some(TextHighlightKind::Invalid)
    } else if scopes.contains("comment") {
        Some(TextHighlightKind::Comment)
    } else if scopes.contains("string") {
        Some(TextHighlightKind::String)
    } else if scopes.contains("constant.numeric") {
        Some(TextHighlightKind::Number)
    } else if scopes.contains("keyword")
        || scopes.contains("storage.modifier")
        || scopes.contains("meta.preprocessor")
    {
        Some(TextHighlightKind::Keyword)
    } else if scopes.contains("entity.name.function") || scopes.contains("support.function") {
        Some(TextHighlightKind::Function)
    } else if scopes.contains("entity.name.type")
        || scopes.contains("entity.name.tag")
        || scopes.contains("support.type")
        || scopes.contains("storage.type")
    {
        Some(TextHighlightKind::Type)
    } else if scopes.contains("variable") {
        Some(TextHighlightKind::Variable)
    } else if scopes.contains("constant") {
        Some(TextHighlightKind::Constant)
    } else {
        None
    }
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

fn render_pdf_page(path: &Path, page_index: usize, cache: &Path) -> ServiceResult<PdfPagePreview> {
    let metadata = fs::metadata(path).map_err(ServiceError::from)?;
    if !metadata.is_file() {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "PDF preview requires a regular file",
        ));
    }
    if extension(path) != "pdf" {
        return Err(ServiceError::new(
            ErrorCode::Unsupported,
            "Native document rendering only accepts PDF files",
        ));
    }
    if metadata.len() > MAX_PDF_BYTES {
        return Err(ServiceError::new(
            ErrorCode::Unsupported,
            "PDF preview is limited to files no larger than 256 MiB",
        ));
    }

    let bytes = fs::read(path).map_err(ServiceError::from)?;
    let document = karet_pdf::Document::load(bytes).map_err(map_pdf_error)?;
    let page_count = document.page_count();
    if page_count == 0 {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            "PDF contains no pages",
        ));
    }
    if page_index >= page_count {
        return Err(ServiceError::new(
            ErrorCode::InvalidInput,
            format!(
                "PDF page {} is outside this {page_count}-page document",
                page_index + 1
            ),
        ));
    }

    fs::create_dir_all(cache).map_err(ServiceError::from)?;
    let suffix = format!("pdf-page-{}-150", page_index + 1);
    let image_path = cache.join(format!("{}.png", cache_key(path, &suffix)));
    let (pixel_width, pixel_height) = if let Some(dimensions) = pdf_png_dimensions(&image_path) {
        dimensions
    } else {
        let rendered = document
            .render_page(page_index, PDF_RENDER_SCALE)
            .map_err(map_pdf_error)?;
        let dimensions = (rendered.width(), rendered.height());
        write_pdf_png_atomically(&image_path, &rendered)?;
        prune_pdf_cache(cache);
        dimensions
    };
    Ok(PdfPagePreview {
        source_path: path.to_path_buf(),
        image_path,
        page_index,
        page_count,
        pixel_width,
        pixel_height,
        display_width: ((pixel_width as f32) / PDF_RENDER_SCALE).round() as u32,
        display_height: ((pixel_height as f32) / PDF_RENDER_SCALE).round() as u32,
    })
}

fn pdf_png_dimensions(path: &Path) -> Option<(u32, u32)> {
    let file = File::open(path).ok()?;
    let reader = png::Decoder::new(BufReader::new(file)).read_info().ok()?;
    let info = reader.info();
    (info.width > 0 && info.height > 0).then_some((info.width, info.height))
}

fn map_pdf_error(error: karet_pdf::PdfError) -> ServiceError {
    match error {
        karet_pdf::PdfError::Encrypted => ServiceError::new(
            ErrorCode::Unsupported,
            "Password-protected PDFs cannot be previewed natively; use Open to view this file",
        ),
        karet_pdf::PdfError::PageOutOfRange { index, count } => ServiceError::new(
            ErrorCode::InvalidInput,
            format!(
                "PDF page {} is outside this {count}-page document",
                index + 1
            ),
        ),
        karet_pdf::PdfError::Parse => ServiceError::new(
            ErrorCode::InvalidInput,
            "PDF is damaged or uses features the native renderer cannot parse",
        ),
        _ => ServiceError::new(
            ErrorCode::Unsupported,
            format!("PDF cannot be rendered natively: {error}"),
        ),
    }
}

fn write_pdf_png_atomically(path: &Path, page: &karet_pdf::RenderedPage) -> ServiceResult<()> {
    let temporary = path.with_extension(format!("png.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let file = File::create(&temporary).map_err(ServiceError::from)?;
        let mut encoder = png::Encoder::new(BufWriter::new(file), page.width(), page.height());
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| {
            ServiceError::new(
                ErrorCode::Internal,
                format!("Unable to encode PDF page: {error}"),
            )
        })?;
        writer.write_image_data(page.rgba()).map_err(|error| {
            ServiceError::new(
                ErrorCode::Internal,
                format!("Unable to encode PDF page: {error}"),
            )
        })?;
        writer.finish().map_err(|error| {
            ServiceError::new(
                ErrorCode::Internal,
                format!("Unable to finish PDF page: {error}"),
            )
        })?;
        if path.exists() {
            if pdf_png_dimensions(path).is_some() {
                fs::remove_file(&temporary).map_err(ServiceError::from)?;
                return Ok(());
            }
            fs::remove_file(path).map_err(ServiceError::from)?;
        }
        match fs::rename(&temporary, path) {
            Ok(()) => Ok(()),
            Err(_) if pdf_png_dimensions(path).is_some() => {
                fs::remove_file(&temporary).map_err(ServiceError::from)
            }
            Err(error) => Err(ServiceError::from(error)),
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn prune_pdf_cache(cache: &Path) {
    let Ok(entries) = fs::read_dir(cache) else {
        return;
    };
    let mut pages: Vec<(PathBuf, std::time::SystemTime, u64)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            if !name.to_string_lossy().contains("-pdf-page-") {
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
    pages.sort_by_key(|(_, modified, _)| *modified);
    let mut total = pages.iter().map(|(_, _, size)| *size).sum::<u64>();
    while pages.len() > MAX_PDF_CACHE_ENTRIES || total > MAX_PDF_CACHE_BYTES {
        let (path, _, size) = pages.remove(0);
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn get_file_icon(path: &Path, cache: &Path) -> ServiceResult<Option<PathBuf>> {
    #[cfg(windows)]
    {
        if !path.exists() {
            return Ok(None);
        }
        let output = cache_output(cache, path, "icon", "png");
        if output.metadata().is_ok_and(|metadata| metadata.len() > 0) {
            return Ok(Some(output));
        }
        fs::create_dir_all(cache).map_err(ServiceError::from)?;
        let script = r#"Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ExplorieShellIcon {
    public static class NativeMethods {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct SHFILEINFO {
            public IntPtr hIcon;
            public int iIcon;
            public uint dwAttributes;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SHGetFileInfo(
            string path,
            uint attributes,
            ref SHFILEINFO info,
            uint infoSize,
            uint flags
        );

        [DllImport("user32.dll")]
        public static extern bool DestroyIcon(IntPtr icon);
    }
}
'@
$info = New-Object ExplorieShellIcon.NativeMethods+SHFILEINFO
$result = [ExplorieShellIcon.NativeMethods]::SHGetFileInfo(
    $env:EXPLORIE_ICON_INPUT,
    0,
    [ref]$info,
    [Runtime.InteropServices.Marshal]::SizeOf($info),
    0x100
)
if ($result -eq [IntPtr]::Zero -or $info.hIcon -eq [IntPtr]::Zero) { exit 2 }
try {
    $borrowed = [System.Drawing.Icon]::FromHandle($info.hIcon)
    try {
        $icon = $borrowed.Clone()
        try {
            $bitmap = $icon.ToBitmap()
            try { $bitmap.Save($env:EXPLORIE_ICON_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png) }
            finally { $bitmap.Dispose() }
        }
        finally { $icon.Dispose() }
    }
    finally { $borrowed.Dispose() }
}
finally { [void][ExplorieShellIcon.NativeMethods]::DestroyIcon($info.hIcon) }"#;
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
            prune_icon_cache(cache);
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

fn prune_icon_cache(cache: &Path) {
    let Ok(entries) = fs::read_dir(cache) else {
        return;
    };
    let mut cached: Vec<(PathBuf, std::time::SystemTime, u64)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            if !name.to_string_lossy().contains("-icon.") {
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
    while cached.len() > MAX_ICON_CACHE_ENTRIES || total > MAX_ICON_CACHE_BYTES {
        let (path, _, size) = cached.remove(0);
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn get_file_thumbnail(path: &Path, max_size: u32, cache: &Path) -> ServiceResult<Option<PathBuf>> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(None);
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Ok(None);
    }
    let is_image = matches!(
        extension(path).as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "tif" | "tiff"
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

fn generate_native_thumbnail(input: &Path, output: &Path, max_size: u32) -> ServiceResult<()> {
    let image = image::ImageReader::open(input)
        .map_err(|error| ServiceError::new(ErrorCode::InvalidInput, error.to_string()))?
        .with_guessed_format()
        .map_err(|error| ServiceError::new(ErrorCode::InvalidInput, error.to_string()))?
        .decode()
        .map_err(|error| ServiceError::new(ErrorCode::InvalidInput, error.to_string()))?;
    image
        .thumbnail(max_size, max_size)
        .save_with_format(output, image::ImageFormat::Png)
        .map_err(|error| ServiceError::new(ErrorCode::Internal, error.to_string()))
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

    fn write_test_image(path: &Path, width: u32, height: u32, color: [u8; 4]) {
        image::RgbaImage::from_pixel(width, height, image::Rgba(color))
            .save(path)
            .unwrap();
    }

    fn minimal_pdf(page_count: usize) -> Vec<u8> {
        let mut bytes = b"%PDF-1.4\n".to_vec();
        let mut objects = Vec::with_capacity(page_count + 2);
        objects.push("<</Type/Catalog/Pages 2 0 R>>".to_string());
        let kids = (0..page_count)
            .map(|index| format!("{} 0 R", index + 3))
            .collect::<Vec<_>>()
            .join(" ");
        objects.push(format!("<</Type/Pages/Kids[{kids}]/Count {page_count}>>"));
        for _ in 0..page_count {
            objects.push("<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>".to_string());
        }
        let mut offsets = Vec::with_capacity(objects.len());
        for (index, object) in objects.iter().enumerate() {
            offsets.push(bytes.len());
            bytes.extend_from_slice(format!("{} 0 obj{object}endobj\n", index + 1).as_bytes());
        }
        let xref = bytes.len();
        bytes.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        bytes.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets {
            bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        bytes.extend_from_slice(
            format!(
                "trailer<</Size {}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF",
                objects.len() + 1
            )
            .as_bytes(),
        );
        bytes
    }

    #[test]
    fn text_preview_is_bounded_and_reports_truncation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("large.txt");
        File::create(&path).unwrap().write_all(b"abcdef").unwrap();
        let service = PreviewService::new(ServiceContext::new(ResourcePaths::test(temp.path())));
        let preview = service.read_text(path, 4).wait().unwrap();
        assert_eq!(preview.text, "abcd");
        assert!(preview.truncated);
        assert_eq!(preview.language, None);
        assert!(!preview.wrapped);
        assert!(preview.highlights.is_empty());
    }

    #[test]
    fn pdf_pages_render_locally_and_cache_by_source_identity() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("document.pdf");
        fs::write(&path, minimal_pdf(2)).unwrap();
        let service = PreviewService::new(ServiceContext::new(ResourcePaths::test(temp.path())));

        let first = service.pdf_page(path.clone(), 0).wait().unwrap();
        assert_eq!(first.page_count, 2);
        assert_eq!(first.page_index, 0);
        assert_eq!((first.display_width, first.display_height), (612, 792));
        assert_eq!((first.pixel_width, first.pixel_height), (918, 1188));
        assert!(first.image_path.is_file());
        assert_eq!(
            &fs::read(&first.image_path).unwrap()[..8],
            b"\x89PNG\r\n\x1a\n"
        );

        let cached = service.pdf_page(path.clone(), 0).wait().unwrap();
        assert_eq!(cached.image_path, first.image_path);
        let second = service.pdf_page(path.clone(), 1).wait().unwrap();
        assert_eq!(second.page_index, 1);
        assert_ne!(second.image_path, first.image_path);

        fs::write(&path, minimal_pdf(1)).unwrap();
        let changed = service.pdf_page(path, 0).wait().unwrap();
        assert_eq!(changed.page_count, 1);
        assert_ne!(changed.image_path, first.image_path);
    }

    #[test]
    fn pdf_failures_are_bounded_and_recoverable() {
        let temp = tempfile::tempdir().unwrap();
        let service = PreviewService::new(ServiceContext::new(ResourcePaths::test(temp.path())));
        let missing = service
            .pdf_page(temp.path().join("missing.pdf"), 0)
            .wait()
            .unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);

        let malformed = temp.path().join("malformed.pdf");
        fs::write(&malformed, b"not a PDF").unwrap();
        let error = service.pdf_page(malformed, 0).wait().unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);

        let oversized = temp.path().join("oversized.pdf");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_PDF_BYTES + 1)
            .unwrap();
        let error = service.pdf_page(oversized, 0).wait().unwrap_err();
        assert_eq!(error.code, ErrorCode::Unsupported);

        let encrypted = map_pdf_error(karet_pdf::PdfError::Encrypted);
        assert_eq!(encrypted.code, ErrorCode::Unsupported);
        assert!(encrypted.message.contains("Password-protected"));
    }

    #[test]
    fn code_preview_detects_language_and_returns_bounded_semantic_ranges() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sample.rs");
        fs::write(
            &path,
            "// local only\npub fn answer() -> u32 { 42 }\nlet label = \"explorie\";\n",
        )
        .unwrap();
        let service = PreviewService::new(ServiceContext::new(ResourcePaths::test(temp.path())));
        let preview = service.read_text(path, 512 * 1024).wait().unwrap();
        assert_eq!(preview.language.as_deref(), Some("Rust"));
        assert!(!preview.wrapped);
        assert!(preview.highlights.len() < MAX_TEXT_HIGHLIGHTS);
        assert!(preview.highlights.iter().all(|highlight| {
            highlight.start < highlight.end
                && highlight.end <= preview.text.len()
                && preview.text.is_char_boundary(highlight.start)
                && preview.text.is_char_boundary(highlight.end)
        }));
        assert!(
            preview
                .highlights
                .iter()
                .any(|highlight| highlight.kind == TextHighlightKind::Comment)
        );
        assert!(
            preview
                .highlights
                .iter()
                .any(|highlight| highlight.kind == TextHighlightKind::Keyword)
        );
        assert!(
            preview
                .highlights
                .iter()
                .any(|highlight| highlight.kind == TextHighlightKind::String)
        );
    }

    #[test]
    fn markdown_wraps_and_unknown_text_remains_plain() {
        let temp = tempfile::tempdir().unwrap();
        let service = PreviewService::new(ServiceContext::new(ResourcePaths::test(temp.path())));
        let markdown = temp.path().join("notes.md");
        fs::write(&markdown, "# Local notes\n\nA long paragraph").unwrap();
        let preview = service.read_text(markdown, 512 * 1024).wait().unwrap();
        assert!(preview.wrapped);
        assert_eq!(preview.language.as_deref(), Some("Markdown"));

        let plain = temp.path().join("events.log");
        fs::write(&plain, "one\ntwo\n").unwrap();
        let preview = service.read_text(plain, 512 * 1024).wait().unwrap();
        assert_eq!(preview.language, None);
        assert!(preview.highlights.is_empty());
    }

    #[test]
    fn legacy_code_aliases_resolve_to_bundled_local_syntaxes() {
        for (extension, source) in [
            ("tsx", "export const View = () => <div>Local</div>;"),
            ("jsonc", "{ // local\n  \"enabled\": true\n}"),
            ("pyw", "def main():\n    return 42\n"),
            ("csharp", "public class Local {}"),
            ("hpp", "struct Local { int value; };"),
            ("bash", "echo \"local\""),
            ("lock", "version = 3"),
        ] {
            let path = PathBuf::from(format!("preview.{extension}"));
            let (language, highlights) = highlight_text(&path, source);
            assert!(language.is_some(), "{extension} should resolve a syntax");
            assert!(
                highlights
                    .iter()
                    .all(|highlight| highlight.end <= source.len()),
                "{extension} ranges should stay inside the source"
            );
        }
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
    fn generated_artifact_cache_paths_track_source_identity_and_artifact_kind() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let source = temp.path().join("design.psd");
        fs::write(&source, b"first identity").unwrap();

        let first = cache_output(&cache, &source, "image", "png");
        assert_eq!(first, cache_output(&cache, &source, "image", "png"));
        assert_ne!(
            first,
            cache_output(&cache, &source, "document", "pdf"),
            "artifact kinds must not share a cache slot"
        );

        fs::write(&source, b"a different and longer source identity").unwrap();
        let changed = cache_output(&cache, &source, "image", "png");
        assert_ne!(
            first, changed,
            "a changed source must not reuse a stale generated artifact"
        );
        assert_eq!(changed.parent(), Some(cache.as_path()));
    }

    #[test]
    fn image_thumbnails_cover_legacy_formats_and_cache_by_source_identity() {
        let temp = tempfile::tempdir().unwrap();
        let service = PreviewService::new(ServiceContext::new(ResourcePaths::test(temp.path())));

        for extension in ["png", "webp"] {
            let source = temp.path().join(format!("photo.{extension}"));
            write_test_image(&source, 320, 180, [40, 120, 220, 255]);
            let first = service
                .thumbnail(source.clone(), 128)
                .wait()
                .unwrap()
                .unwrap();
            let cached = service
                .thumbnail(source.clone(), 128)
                .wait()
                .unwrap()
                .unwrap();
            assert_eq!(first, cached);
            assert_eq!(image::image_dimensions(&first).unwrap(), (128, 72));
            assert_eq!(&fs::read(&first).unwrap()[..8], b"\x89PNG\r\n\x1a\n");

            write_test_image(&source, 240, 240, [220, 80, 60, 255]);
            let changed = service.thumbnail(source, 128).wait().unwrap().unwrap();
            assert_ne!(changed, first);
            assert_eq!(image::image_dimensions(changed).unwrap(), (128, 128));
        }
    }

    #[test]
    fn video_thumbnail_uses_real_ffmpeg_when_available() {
        let Some(ffmpeg) = first_available_tool(&["ffmpeg"], "-version") else {
            eprintln!("skipping video thumbnail test: FFmpeg unavailable");
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("clip.mp4");
        let generated = command(&ffmpeg)
            .args([
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=160x90:rate=15",
                "-t",
                "1",
                "-c:v",
                "mpeg4",
                "-pix_fmt",
                "yuv420p",
                "-y",
            ])
            .arg(&source)
            .status()
            .unwrap();
        assert!(generated.success());

        let service = PreviewService::new(ServiceContext::new(ResourcePaths::test(temp.path())));
        let thumbnail = service.thumbnail(source, 128).wait().unwrap().unwrap();
        let (width, height) = image::image_dimensions(&thumbnail).unwrap();
        assert!(width <= 128 && height <= 128);
        assert_eq!(&fs::read(thumbnail).unwrap()[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_icons_cover_regular_files_and_folders_and_reuse_cache() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("notes.txt");
        let folder = temp.path().join("folder");
        fs::write(&source, "local").unwrap();
        fs::create_dir(&folder).unwrap();
        let service = PreviewService::new(ServiceContext::new(ResourcePaths::test(temp.path())));

        let file_icon = service.file_icon(source).wait().unwrap().unwrap();
        let folder_icon = service.file_icon(folder.clone()).wait().unwrap().unwrap();
        let cached_folder_icon = service.file_icon(folder).wait().unwrap().unwrap();

        assert_eq!(&fs::read(&file_icon).unwrap()[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&fs::read(&folder_icon).unwrap()[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(folder_icon, cached_folder_icon);
    }

    #[test]
    fn external_extensions_have_named_routes() {
        assert!(is_external_document(Path::new("file.docx")));
        assert!(is_external_video(Path::new("file.mkv")));
        assert!(is_external_image(Path::new("file.heic")));
        assert!(!is_external_image(Path::new("file.png")));
    }
}
