use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

// Re-export Password for 7z operations
pub use sevenz_rust::Password as SevenZPassword;

/// Supported archive formats
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveFormat {
    Zip,
    TarGz,
    Tar,
    Rar,
    SevenZ,
}

fn validate_archive_entry_path(entry_path: &Path) -> io::Result<()> {
    for component in entry_path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Invalid archive: unsafe path component detected",
                ));
            }
            Component::CurDir => continue,
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                if name.contains('\0') {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Invalid archive: null byte in path",
                    ));
                }
                if cfg!(windows) {
                    let trimmed = name.trim_end_matches([' ', '.']);
                    if trimmed.is_empty() || trimmed != name {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "Invalid archive: unsafe Windows path component",
                        ));
                    }
                    let upper = trimmed.to_ascii_uppercase();
                    let base = upper.split('.').next().unwrap_or("");
                    if matches!(base, "CON" | "PRN" | "AUX" | "NUL") {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "Invalid archive: reserved Windows filename",
                        ));
                    }
                    if let Some(num) = base
                        .strip_prefix("COM")
                        .or_else(|| base.strip_prefix("LPT"))
                        && matches!(num, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                    {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "Invalid archive: reserved Windows filename",
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

impl ArchiveFormat {
    /// Get the file extension for this format
    pub fn extension(&self) -> &'static str {
        match self {
            ArchiveFormat::Zip => "zip",
            ArchiveFormat::TarGz => "tar.gz",
            ArchiveFormat::Tar => "tar",
            ArchiveFormat::Rar => "rar",
            ArchiveFormat::SevenZ => "7z",
        }
    }

    /// Detect format from file extension
    pub fn from_path(path: &Path) -> Option<Self> {
        let name = path.file_name()?.to_str()?.to_lowercase();
        if name.ends_with(".zip") {
            Some(ArchiveFormat::Zip)
        } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
            Some(ArchiveFormat::TarGz)
        } else if name.ends_with(".tar") {
            Some(ArchiveFormat::Tar)
        } else if name.ends_with(".rar") {
            Some(ArchiveFormat::Rar)
        } else if name.ends_with(".7z") {
            Some(ArchiveFormat::SevenZ)
        } else {
            None
        }
    }

    /// Check if format supports creation (not just extraction)
    pub fn supports_creation(&self) -> bool {
        match self {
            ArchiveFormat::Zip
            | ArchiveFormat::TarGz
            | ArchiveFormat::Tar
            | ArchiveFormat::SevenZ => true,
            ArchiveFormat::Rar => false, // RAR is extract-only
        }
    }
}

/// Compression level for archives
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompressionLevel {
    None,
    Fast,
    Normal,
    Best,
}

impl CompressionLevel {
    fn to_flate2_level(self) -> flate2::Compression {
        match self {
            CompressionLevel::None => flate2::Compression::none(),
            CompressionLevel::Fast => flate2::Compression::fast(),
            CompressionLevel::Normal => flate2::Compression::default(),
            CompressionLevel::Best => flate2::Compression::best(),
        }
    }
}

/// Information about an archive entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub compressed_size: u64,
    pub is_dir: bool,
}

/// Result of listing archive contents
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveInfo {
    pub format: String,
    pub total_size: u64,
    pub compressed_size: u64,
    pub entry_count: usize,
    pub entries: Vec<ArchiveEntry>,
}

#[derive(Debug, Clone)]
pub struct ArchiveProgress {
    pub processed_bytes: u64,
    pub total_bytes: u64,
    pub current_path: String,
}

/// Options for creating an archive
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressOptions {
    pub format: ArchiveFormat,
    pub compression_level: CompressionLevel,
    pub password: Option<String>,
}

impl Default for CompressOptions {
    fn default() -> Self {
        Self {
            format: ArchiveFormat::Zip,
            compression_level: CompressionLevel::Normal,
            password: None,
        }
    }
}

fn estimate_sources_total_bytes(sources: &[PathBuf]) -> io::Result<u64> {
    let mut total: u64 = 0;
    for source in sources {
        if source.is_file() {
            if let Ok(metadata) = fs::metadata(source) {
                total = total.saturating_add(metadata.len());
            }
            continue;
        }
        if source.is_dir() {
            for entry in WalkDir::new(source).into_iter().filter_map(|e| e.ok()) {
                if entry.file_type().is_symlink() {
                    continue;
                }
                if entry.file_type().is_file()
                    && let Ok(metadata) = entry.metadata()
                {
                    total = total.saturating_add(metadata.len());
                }
            }
        }
    }
    Ok(total)
}

/// Create a ZIP archive from a list of files/directories
pub fn create_zip_archive(
    sources: &[PathBuf],
    output_path: &Path,
    compression_level: CompressionLevel,
) -> io::Result<u64> {
    let file = File::create(output_path)?;
    let writer = BufWriter::new(file);
    let mut zip = ZipWriter::new(writer);

    let method = match compression_level {
        CompressionLevel::None => CompressionMethod::Stored,
        _ => CompressionMethod::Deflated,
    };

    let options: SimpleFileOptions = SimpleFileOptions::default()
        .compression_method(method)
        .unix_permissions(0o755);

    let mut total_bytes: u64 = 0;

    for source in sources {
        if source.is_dir() {
            total_bytes += add_directory_to_zip(&mut zip, source, source, options)?;
        } else if source.is_file() {
            total_bytes += add_file_to_zip(
                &mut zip,
                source,
                source.file_name().unwrap().to_str().unwrap(),
                options,
            )?;
        }
    }

    zip.finish()?;
    Ok(total_bytes)
}

pub fn create_zip_archive_with_progress(
    sources: &[PathBuf],
    output_path: &Path,
    compression_level: CompressionLevel,
    progress: &mut impl FnMut(&Path, u64),
) -> io::Result<u64> {
    let file = File::create(output_path)?;
    let writer = BufWriter::new(file);
    let mut zip = ZipWriter::new(writer);

    let method = match compression_level {
        CompressionLevel::None => CompressionMethod::Stored,
        _ => CompressionMethod::Deflated,
    };

    let options = SimpleFileOptions::default()
        .compression_method(method)
        .unix_permissions(0o755);

    let mut total_bytes: u64 = 0;

    for source in sources {
        if source.is_dir() {
            total_bytes +=
                add_directory_to_zip_with_progress(&mut zip, source, source, options, progress)?;
        } else if source.is_file() {
            total_bytes += add_file_to_zip_with_progress(
                &mut zip,
                source,
                source.file_name().unwrap().to_str().unwrap(),
                options,
                progress,
            )?;
        }
    }

    zip.finish()?;
    Ok(total_bytes)
}

fn add_directory_to_zip_with_progress<'a, W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    dir_path: &Path,
    base_path: &Path,
    options: zip::write::FileOptions<'a, ()>,
    progress: &mut impl FnMut(&Path, u64),
) -> io::Result<u64> {
    let mut total_bytes: u64 = 0;
    let base_name = base_path
        .file_name()
        .unwrap_or_default()
        .to_str()
        .unwrap_or("");

    for entry in WalkDir::new(dir_path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let relative_path = path.strip_prefix(dir_path).unwrap_or(path);

        // Build the archive path with the base directory name
        let archive_path = if relative_path.as_os_str().is_empty() {
            base_name.to_string()
        } else {
            format!(
                "{}/{}",
                base_name,
                relative_path.to_string_lossy().replace('\\', "/")
            )
        };

        if path.is_dir() {
            // Add directory entry
            let dir_name = format!("{}/", archive_path);
            zip.add_directory(&dir_name, options)?;
        } else if path.is_file() {
            total_bytes +=
                add_file_to_zip_with_progress(zip, path, &archive_path, options, progress)?;
        }
    }

    Ok(total_bytes)
}

fn add_file_to_zip_with_progress<'a, W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    file_path: &Path,
    archive_name: &str,
    options: zip::write::FileOptions<'a, ()>,
    progress: &mut impl FnMut(&Path, u64),
) -> io::Result<u64> {
    let size = write_file_to_zip(zip, file_path, archive_name, options)?;
    progress(file_path, size);
    Ok(size)
}

fn add_directory_to_zip<'a, W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    dir_path: &Path,
    base_path: &Path,
    options: zip::write::FileOptions<'a, ()>,
) -> io::Result<u64> {
    let mut total_bytes: u64 = 0;
    let base_name = base_path
        .file_name()
        .unwrap_or_default()
        .to_str()
        .unwrap_or("");

    for entry in WalkDir::new(dir_path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let relative_path = path.strip_prefix(dir_path).unwrap_or(path);

        // Build the archive path with the base directory name
        let archive_path = if relative_path.as_os_str().is_empty() {
            base_name.to_string()
        } else {
            format!(
                "{}/{}",
                base_name,
                relative_path.to_string_lossy().replace('\\', "/")
            )
        };

        if path.is_dir() {
            // Add directory entry
            let dir_name = format!("{}/", archive_path);
            zip.add_directory(&dir_name, options)?;
        } else if path.is_file() {
            total_bytes += add_file_to_zip(zip, path, &archive_path, options)?;
        }
    }

    Ok(total_bytes)
}

fn add_file_to_zip<'a, W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    file_path: &Path,
    archive_name: &str,
    options: zip::write::FileOptions<'a, ()>,
) -> io::Result<u64> {
    write_file_to_zip(zip, file_path, archive_name, options)
}

fn write_file_to_zip<'a, W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    file_path: &Path,
    archive_name: &str,
    options: zip::write::FileOptions<'a, ()>,
) -> io::Result<u64> {
    let mut file = File::open(file_path)?;
    let metadata = file.metadata()?;
    let size = metadata.len();

    zip.start_file(archive_name, options)?;

    let mut buffer = vec![0u8; 65536]; // 64KB buffer
    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        zip.write_all(&buffer[..bytes_read])?;
    }

    Ok(size)
}

/// Create a TAR archive (optionally gzipped) from a list of files/directories
pub fn create_tar_archive(
    sources: &[PathBuf],
    output_path: &Path,
    gzip: bool,
    compression_level: CompressionLevel,
) -> io::Result<u64> {
    let file = File::create(output_path)?;
    let mut total_bytes: u64 = 0;

    if gzip {
        let encoder = flate2::write::GzEncoder::new(
            BufWriter::new(file),
            compression_level.to_flate2_level(),
        );
        let mut archive = tar::Builder::new(encoder);

        for source in sources {
            if source.is_dir() {
                total_bytes += add_directory_to_tar(&mut archive, source)?;
            } else if source.is_file() {
                let name = source.file_name().unwrap().to_str().unwrap();
                total_bytes += add_file_to_tar(&mut archive, source, name)?;
            }
        }

        archive.finish()?;
    } else {
        let mut archive = tar::Builder::new(BufWriter::new(file));

        for source in sources {
            if source.is_dir() {
                total_bytes += add_directory_to_tar(&mut archive, source)?;
            } else if source.is_file() {
                let name = source.file_name().unwrap().to_str().unwrap();
                total_bytes += add_file_to_tar(&mut archive, source, name)?;
            }
        }

        archive.finish()?;
    }

    Ok(total_bytes)
}

pub fn create_tar_archive_with_progress(
    sources: &[PathBuf],
    output_path: &Path,
    gzip: bool,
    compression_level: CompressionLevel,
    progress: &mut impl FnMut(&Path, u64),
) -> io::Result<u64> {
    let file = File::create(output_path)?;
    let mut total_bytes: u64 = 0;

    if gzip {
        let encoder = flate2::write::GzEncoder::new(
            BufWriter::new(file),
            compression_level.to_flate2_level(),
        );
        let mut archive = tar::Builder::new(encoder);

        for source in sources {
            if source.is_dir() {
                total_bytes += add_directory_to_tar_with_progress(&mut archive, source, progress)?;
            } else if source.is_file() {
                let name = source.file_name().unwrap().to_str().unwrap();
                total_bytes += add_file_to_tar_with_progress(&mut archive, source, name, progress)?;
            }
        }

        archive.finish()?;
    } else {
        let mut archive = tar::Builder::new(BufWriter::new(file));

        for source in sources {
            if source.is_dir() {
                total_bytes += add_directory_to_tar_with_progress(&mut archive, source, progress)?;
            } else if source.is_file() {
                let name = source.file_name().unwrap().to_str().unwrap();
                total_bytes += add_file_to_tar_with_progress(&mut archive, source, name, progress)?;
            }
        }

        archive.finish()?;
    }

    Ok(total_bytes)
}

fn add_directory_to_tar_with_progress<W: Write>(
    archive: &mut tar::Builder<W>,
    dir_path: &Path,
    progress: &mut impl FnMut(&Path, u64),
) -> io::Result<u64> {
    let mut total_bytes: u64 = 0;
    let _base_name = dir_path.file_name().unwrap_or_default();

    for entry in WalkDir::new(dir_path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            let relative_path = path
                .strip_prefix(dir_path.parent().unwrap_or(dir_path))
                .unwrap_or(path);
            let archive_name = relative_path.to_string_lossy().replace('\\', "/");
            total_bytes += add_file_to_tar_with_progress(archive, path, &archive_name, progress)?;
        }
    }

    Ok(total_bytes)
}

fn add_file_to_tar_with_progress<W: Write>(
    archive: &mut tar::Builder<W>,
    file_path: &Path,
    archive_name: &str,
    progress: &mut impl FnMut(&Path, u64),
) -> io::Result<u64> {
    let size = add_file_to_tar(archive, file_path, archive_name)?;
    progress(file_path, size);
    Ok(size)
}

fn add_directory_to_tar<W: Write>(
    archive: &mut tar::Builder<W>,
    dir_path: &Path,
) -> io::Result<u64> {
    let mut total_bytes: u64 = 0;
    let _base_name = dir_path.file_name().unwrap_or_default();

    for entry in WalkDir::new(dir_path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            let relative_path = path
                .strip_prefix(dir_path.parent().unwrap_or(dir_path))
                .unwrap_or(path);
            let archive_name = relative_path.to_string_lossy().replace('\\', "/");
            total_bytes += add_file_to_tar(archive, path, &archive_name)?;
        }
    }

    Ok(total_bytes)
}

fn add_file_to_tar<W: Write>(
    archive: &mut tar::Builder<W>,
    file_path: &Path,
    archive_name: &str,
) -> io::Result<u64> {
    let mut file = File::open(file_path)?;
    let metadata = file.metadata()?;
    let size = metadata.len();

    let mut header = tar::Header::new_gnu();
    header.set_path(archive_name)?;
    header.set_size(size);
    header.set_mode(0o644);
    header.set_mtime(
        metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0),
    );
    header.set_cksum();

    archive.append(&header, &mut file)?;
    Ok(size)
}

/// Extract a ZIP archive to a directory
pub fn extract_zip_archive(archive_path: &Path, output_dir: &Path) -> io::Result<u64> {
    let file = File::open(archive_path)?;
    let reader = BufReader::new(file);
    let mut archive = ZipArchive::new(reader)?;
    let mut total_bytes: u64 = 0;

    // Create output directory if it doesn't exist
    fs::create_dir_all(output_dir)?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let name = file.name().to_string();
        validate_archive_entry_path(Path::new(&name))?;

        // Security: prevent path traversal attacks
        let out_path = output_dir.join(&name);
        if !out_path.starts_with(output_dir) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid archive: path traversal attempt detected",
            ));
        }

        if file.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            // Create parent directories if needed
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }

            let mut out_file = File::create(&out_path)?;
            let mut buffer = vec![0u8; 65536];
            loop {
                let bytes_read = file.read(&mut buffer)?;
                if bytes_read == 0 {
                    break;
                }
                out_file.write_all(&buffer[..bytes_read])?;
                total_bytes += bytes_read as u64;
            }
        }
    }

    Ok(total_bytes)
}

/// Extract a TAR archive (optionally gzipped) to a directory
pub fn extract_tar_archive(archive_path: &Path, output_dir: &Path, gzip: bool) -> io::Result<u64> {
    let file = File::open(archive_path)?;

    // Create output directory if it doesn't exist
    fs::create_dir_all(output_dir)?;

    let total_bytes = if gzip {
        let decoder = flate2::read::GzDecoder::new(BufReader::new(file));
        let mut archive = tar::Archive::new(decoder);
        extract_tar_entries(&mut archive, output_dir)?
    } else {
        let mut archive = tar::Archive::new(BufReader::new(file));
        extract_tar_entries(&mut archive, output_dir)?
    };

    Ok(total_bytes)
}

fn extract_tar_entries<R: Read>(
    archive: &mut tar::Archive<R>,
    output_dir: &Path,
) -> io::Result<u64> {
    let mut total_bytes: u64 = 0;

    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;
        validate_archive_entry_path(&path)?;
        let out_path = output_dir.join(&path);

        // Security: prevent path traversal attacks
        if !out_path.starts_with(output_dir) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid archive: path traversal attempt detected",
            ));
        }

        // Create parent directories if needed
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }

        entry.unpack(&out_path)?;
        total_bytes += entry.size();
    }

    Ok(total_bytes)
}

/// List contents of a ZIP archive
pub fn list_zip_contents(archive_path: &Path) -> io::Result<ArchiveInfo> {
    let file = File::open(archive_path)?;
    let reader = BufReader::new(file);
    let mut archive = ZipArchive::new(reader)?;

    let mut entries = Vec::with_capacity(archive.len());
    let mut total_size: u64 = 0;
    let mut compressed_size: u64 = 0;

    for i in 0..archive.len() {
        let file = archive.by_index_raw(i)?;
        let name = file.name().to_string();
        let is_dir = name.ends_with('/');
        let size = file.size();
        let comp_size = file.compressed_size();

        total_size += size;
        compressed_size += comp_size;

        entries.push(ArchiveEntry {
            name: name.split('/').next_back().unwrap_or(&name).to_string(),
            path: name,
            size,
            compressed_size: comp_size,
            is_dir,
        });
    }

    Ok(ArchiveInfo {
        format: "zip".to_string(),
        total_size,
        compressed_size,
        entry_count: entries.len(),
        entries,
    })
}

/// List contents of a TAR archive (optionally gzipped)
pub fn list_tar_contents(archive_path: &Path, gzip: bool) -> io::Result<ArchiveInfo> {
    let file = File::open(archive_path)?;
    let mut entries = Vec::new();
    let mut total_size: u64 = 0;

    if gzip {
        let decoder = flate2::read::GzDecoder::new(BufReader::new(file));
        let mut archive = tar::Archive::new(decoder);
        for entry in archive.entries()? {
            let entry = entry?;
            let path = entry.path()?.to_string_lossy().to_string();
            let size = entry.size();
            let is_dir = entry.header().entry_type().is_dir();

            total_size += size;
            entries.push(ArchiveEntry {
                name: path.split('/').next_back().unwrap_or(&path).to_string(),
                path,
                size,
                compressed_size: size, // TAR doesn't compress individual entries
                is_dir,
            });
        }
    } else {
        let mut archive = tar::Archive::new(BufReader::new(file));
        for entry in archive.entries()? {
            let entry = entry?;
            let path = entry.path()?.to_string_lossy().to_string();
            let size = entry.size();
            let is_dir = entry.header().entry_type().is_dir();

            total_size += size;
            entries.push(ArchiveEntry {
                name: path.split('/').next_back().unwrap_or(&path).to_string(),
                path,
                size,
                compressed_size: size,
                is_dir,
            });
        }
    }

    let format = if gzip { "tar.gz" } else { "tar" };
    let compressed_size = fs::metadata(archive_path)?.len();

    Ok(ArchiveInfo {
        format: format.to_string(),
        total_size,
        compressed_size,
        entry_count: entries.len(),
        entries,
    })
}

/// Extract a RAR archive to a directory (extract only - RAR creation not supported)
pub fn extract_rar_archive(
    archive_path: &Path,
    output_dir: &Path,
    password: Option<&str>,
) -> io::Result<u64> {
    // Create output directory if it doesn't exist
    fs::create_dir_all(output_dir)?;

    let archive = if let Some(pwd) = password {
        unrar::Archive::with_password(archive_path, pwd)
    } else {
        unrar::Archive::new(archive_path)
    };

    let mut archive = archive.open_for_processing().map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Failed to open RAR: {:?}", e),
        )
    })?;

    let mut total_bytes: u64 = 0;

    while let Some(header) = archive.read_header().map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Failed to read RAR header: {:?}", e),
        )
    })? {
        validate_archive_entry_path(&header.entry().filename)?;
        let entry_path = output_dir.join(&header.entry().filename);

        // Security: prevent path traversal attacks
        if !entry_path.starts_with(output_dir) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid archive: path traversal attempt detected",
            ));
        }

        // Create parent directories if needed
        if let Some(parent) = entry_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let size = header.entry().unpacked_size;
        archive = header
            .extract_to(&entry_path)
            .map_err(|e| io::Error::other(format!("Failed to extract RAR entry: {:?}", e)))?;

        total_bytes += size;
    }

    Ok(total_bytes)
}

/// List contents of a RAR archive
pub fn list_rar_contents(archive_path: &Path) -> io::Result<ArchiveInfo> {
    let archive = unrar::Archive::new(archive_path)
        .open_for_listing()
        .map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Failed to open RAR: {:?}", e),
            )
        })?;

    let mut entries = Vec::new();
    let mut total_size: u64 = 0;

    for entry_result in archive {
        let entry = entry_result.map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Failed to read RAR entry: {:?}", e),
            )
        })?;

        let path = entry.filename.to_string_lossy().to_string();
        let is_dir = entry.is_directory();
        let size = entry.unpacked_size;

        total_size += size;

        entries.push(ArchiveEntry {
            name: path
                .split(['/', '\\'])
                .next_back()
                .unwrap_or(&path)
                .to_string(),
            path,
            size,
            compressed_size: size, // RAR doesn't expose packed_size in FileHeader
            is_dir,
        });
    }

    // Get compressed size from file metadata
    let compressed_size = fs::metadata(archive_path)?.len();

    Ok(ArchiveInfo {
        format: "rar".to_string(),
        total_size,
        compressed_size,
        entry_count: entries.len(),
        entries,
    })
}

/// Create a 7Z archive from a list of files/directories
pub fn create_7z_archive(
    sources: &[PathBuf],
    output_path: &Path,
    _password: Option<&str>,
) -> io::Result<u64> {
    let mut total_bytes: u64 = 0;
    let output_file = File::create(output_path)?;
    let mut sz = sevenz_rust::SevenZWriter::new(output_file)
        .map_err(|e| io::Error::other(format!("Failed to create 7z: {:?}", e)))?;

    // Use LZMA2 compression method
    sz.set_content_methods(vec![sevenz_rust::SevenZMethodConfiguration::new(
        sevenz_rust::SevenZMethod::LZMA2,
    )]);
    // Note: Password-protected 7z creation is not fully supported by sevenz-rust

    for source in sources {
        if source.is_dir() {
            total_bytes += add_directory_to_7z(&mut sz, source)?;
        } else if source.is_file() {
            let name = source.file_name().unwrap().to_str().unwrap();
            total_bytes += add_file_to_7z(&mut sz, source, name)?;
        }
    }

    sz.finish()
        .map_err(|e| io::Error::other(format!("Failed to finish 7z: {:?}", e)))?;

    Ok(total_bytes)
}

pub fn create_7z_archive_with_progress(
    sources: &[PathBuf],
    output_path: &Path,
    _password: Option<&str>,
    progress: &mut impl FnMut(&Path, u64),
) -> io::Result<u64> {
    let mut total_bytes: u64 = 0;
    let output_file = File::create(output_path)?;
    let mut sz = sevenz_rust::SevenZWriter::new(output_file)
        .map_err(|e| io::Error::other(format!("Failed to create 7z: {:?}", e)))?;

    // Use LZMA2 compression method
    sz.set_content_methods(vec![sevenz_rust::SevenZMethodConfiguration::new(
        sevenz_rust::SevenZMethod::LZMA2,
    )]);
    // Note: Password-protected 7z creation is not fully supported by sevenz-rust

    for source in sources {
        if source.is_dir() {
            total_bytes += add_directory_to_7z_with_progress(&mut sz, source, progress)?;
        } else if source.is_file() {
            let name = source.file_name().unwrap().to_str().unwrap();
            total_bytes += add_file_to_7z_with_progress(&mut sz, source, name, progress)?;
        }
    }

    sz.finish()
        .map_err(|e| io::Error::other(format!("Failed to finish 7z: {:?}", e)))?;

    Ok(total_bytes)
}

fn add_directory_to_7z_with_progress<W: Write + io::Seek>(
    sz: &mut sevenz_rust::SevenZWriter<W>,
    dir_path: &Path,
    progress: &mut impl FnMut(&Path, u64),
) -> io::Result<u64> {
    let mut total_bytes: u64 = 0;
    let _base_name = dir_path.file_name().unwrap_or_default();

    for entry in WalkDir::new(dir_path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            let relative_path = path
                .strip_prefix(dir_path.parent().unwrap_or(dir_path))
                .unwrap_or(path);
            let archive_name = relative_path.to_string_lossy().replace('\\', "/");
            total_bytes += add_file_to_7z_with_progress(sz, path, &archive_name, progress)?;
        }
    }

    Ok(total_bytes)
}

fn add_file_to_7z_with_progress<W: Write + io::Seek>(
    sz: &mut sevenz_rust::SevenZWriter<W>,
    file_path: &Path,
    archive_name: &str,
    progress: &mut impl FnMut(&Path, u64),
) -> io::Result<u64> {
    let size = add_file_to_7z(sz, file_path, archive_name)?;
    progress(file_path, size);
    Ok(size)
}

fn add_directory_to_7z<W: Write + io::Seek>(
    sz: &mut sevenz_rust::SevenZWriter<W>,
    dir_path: &Path,
) -> io::Result<u64> {
    let mut total_bytes: u64 = 0;
    let _base_name = dir_path.file_name().unwrap_or_default();

    for entry in WalkDir::new(dir_path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            let relative_path = path
                .strip_prefix(dir_path.parent().unwrap_or(dir_path))
                .unwrap_or(path);
            let archive_name = relative_path.to_string_lossy().replace('\\', "/");
            total_bytes += add_file_to_7z(sz, path, &archive_name)?;
        }
    }

    Ok(total_bytes)
}

fn add_file_to_7z<W: Write + io::Seek>(
    sz: &mut sevenz_rust::SevenZWriter<W>,
    file_path: &Path,
    archive_name: &str,
) -> io::Result<u64> {
    let mut file = File::open(file_path)?;
    let metadata = file.metadata()?;
    let size = metadata.len();

    let entry = sevenz_rust::SevenZArchiveEntry::from_path(file_path, archive_name.to_string());
    sz.push_archive_entry(entry, Some(&mut file))
        .map_err(|e| io::Error::other(format!("Failed to add file to 7z: {:?}", e)))?;

    Ok(size)
}

/// Extract a 7Z archive to a directory
pub fn extract_7z_archive(
    archive_path: &Path,
    output_dir: &Path,
    password: Option<&str>,
) -> io::Result<u64> {
    // Create output directory if it doesn't exist
    fs::create_dir_all(output_dir)?;

    let mut total_bytes: u64 = 0;
    validate_7z_entries(archive_path, password)?;

    if let Some(pwd) = password {
        sevenz_rust::decompress_file_with_password(archive_path, output_dir, pwd.into()).map_err(
            |e| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Failed to extract 7z: {:?}", e),
                )
            },
        )?;
    } else {
        sevenz_rust::decompress_file(archive_path, output_dir).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Failed to extract 7z: {:?}", e),
            )
        })?;
    }

    // Calculate total bytes extracted by walking the output directory
    for entry in WalkDir::new(output_dir).into_iter().filter_map(|e| e.ok()) {
        if entry.path().is_file()
            && let Ok(meta) = entry.metadata()
        {
            total_bytes += meta.len();
        }
    }

    Ok(total_bytes)
}

/// List contents of a 7Z archive
pub fn list_7z_contents(archive_path: &Path) -> io::Result<ArchiveInfo> {
    let file = File::open(archive_path)?;
    let len = file.metadata()?.len();
    let reader = BufReader::new(file);
    let archive = sevenz_rust::SevenZReader::new(reader, len, sevenz_rust::Password::empty())
        .map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Failed to open 7z: {:?}", e),
            )
        })?;

    let mut entries = Vec::new();
    let mut total_size: u64 = 0;

    for entry in archive.archive().files.iter() {
        let path = entry.name().to_string();
        let is_dir = entry.is_directory();
        let size = entry.size();

        total_size += size;

        entries.push(ArchiveEntry {
            name: path
                .split(['/', '\\'])
                .next_back()
                .unwrap_or(&path)
                .to_string(),
            path,
            size,
            compressed_size: size, // 7z doesn't provide per-entry compressed size easily
            is_dir,
        });
    }

    let compressed_size = fs::metadata(archive_path)?.len();

    Ok(ArchiveInfo {
        format: "7z".to_string(),
        total_size,
        compressed_size,
        entry_count: entries.len(),
        entries,
    })
}

fn validate_7z_entries(archive_path: &Path, password: Option<&str>) -> io::Result<()> {
    let file = File::open(archive_path)?;
    let len = file.metadata()?.len();
    let reader = BufReader::new(file);
    let pwd = password
        .map(SevenZPassword::from)
        .unwrap_or_else(SevenZPassword::empty);
    let archive = sevenz_rust::SevenZReader::new(reader, len, pwd).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Failed to open 7z: {:?}", e),
        )
    })?;

    for entry in archive.archive().files.iter() {
        validate_archive_entry_path(Path::new(entry.name()))?;
    }

    Ok(())
}

/// Detect archive format and list its contents
pub fn list_archive_contents(archive_path: &Path) -> io::Result<ArchiveInfo> {
    match ArchiveFormat::from_path(archive_path) {
        Some(ArchiveFormat::Zip) => list_zip_contents(archive_path),
        Some(ArchiveFormat::TarGz) => list_tar_contents(archive_path, true),
        Some(ArchiveFormat::Tar) => list_tar_contents(archive_path, false),
        Some(ArchiveFormat::Rar) => list_rar_contents(archive_path),
        Some(ArchiveFormat::SevenZ) => list_7z_contents(archive_path),
        None => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Unsupported archive format",
        )),
    }
}

/// Detect archive format and extract it
pub fn extract_archive(archive_path: &Path, output_dir: &Path) -> io::Result<u64> {
    extract_archive_with_password(archive_path, output_dir, None)
}

/// Detect archive format and extract it with optional password
pub fn extract_archive_with_password(
    archive_path: &Path,
    output_dir: &Path,
    password: Option<&str>,
) -> io::Result<u64> {
    match ArchiveFormat::from_path(archive_path) {
        Some(ArchiveFormat::Zip) => {
            if password.is_some() {
                extract_zip_archive_with_password(archive_path, output_dir, password)
            } else {
                extract_zip_archive(archive_path, output_dir)
            }
        }
        Some(ArchiveFormat::TarGz) => extract_tar_archive(archive_path, output_dir, true),
        Some(ArchiveFormat::Tar) => extract_tar_archive(archive_path, output_dir, false),
        Some(ArchiveFormat::Rar) => extract_rar_archive(archive_path, output_dir, password),
        Some(ArchiveFormat::SevenZ) => extract_7z_archive(archive_path, output_dir, password),
        None => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Unsupported archive format",
        )),
    }
}

/// Extract a password-protected ZIP archive to a directory
pub fn extract_zip_archive_with_password(
    archive_path: &Path,
    output_dir: &Path,
    password: Option<&str>,
) -> io::Result<u64> {
    let file = File::open(archive_path)?;
    let reader = BufReader::new(file);
    let mut archive = ZipArchive::new(reader)?;
    let mut total_bytes: u64 = 0;

    // Create output directory if it doesn't exist
    fs::create_dir_all(output_dir)?;

    for i in 0..archive.len() {
        let mut file = if let Some(pwd) = password {
            archive.by_index_decrypt(i, pwd.as_bytes())?
        } else {
            archive.by_index(i)?
        };

        let name = file.name().to_string();
        validate_archive_entry_path(Path::new(&name))?;

        // Security: prevent path traversal attacks
        let out_path = output_dir.join(&name);
        if !out_path.starts_with(output_dir) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid archive: path traversal attempt detected",
            ));
        }

        if file.is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            // Create parent directories if needed
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }

            let mut out_file = File::create(&out_path)?;
            let mut buffer = vec![0u8; 65536];
            loop {
                let bytes_read = file.read(&mut buffer)?;
                if bytes_read == 0 {
                    break;
                }
                out_file.write_all(&buffer[..bytes_read])?;
                total_bytes += bytes_read as u64;
            }
        }
    }

    Ok(total_bytes)
}

/// Create an archive from sources with the specified format
pub fn create_archive(
    sources: &[PathBuf],
    output_path: &Path,
    options: &CompressOptions,
) -> io::Result<u64> {
    match options.format {
        ArchiveFormat::Zip => {
            if options.password.is_some() {
                create_zip_archive_with_password(
                    sources,
                    output_path,
                    options.compression_level,
                    options.password.as_deref(),
                )
            } else {
                create_zip_archive(sources, output_path, options.compression_level)
            }
        }
        ArchiveFormat::TarGz => {
            create_tar_archive(sources, output_path, true, options.compression_level)
        }
        ArchiveFormat::Tar => {
            create_tar_archive(sources, output_path, false, options.compression_level)
        }
        ArchiveFormat::Rar => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "RAR creation is not supported. RAR is extract-only.",
        )),
        ArchiveFormat::SevenZ => {
            create_7z_archive(sources, output_path, options.password.as_deref())
        }
    }
}

pub fn create_archive_with_progress(
    sources: &[PathBuf],
    output_path: &Path,
    options: &CompressOptions,
    mut on_progress: impl FnMut(ArchiveProgress),
) -> io::Result<u64> {
    let total_bytes = estimate_sources_total_bytes(sources)?;
    let mut processed_bytes: u64 = 0;

    let mut progress = |path: &Path, bytes: u64| {
        processed_bytes = processed_bytes.saturating_add(bytes);
        on_progress(ArchiveProgress {
            processed_bytes,
            total_bytes,
            current_path: path.to_string_lossy().to_string(),
        });
    };

    match options.format {
        ArchiveFormat::Zip => {
            if options.password.is_some() {
                create_zip_archive_with_password_and_progress(
                    sources,
                    output_path,
                    options.compression_level,
                    options.password.as_deref(),
                    &mut progress,
                )
            } else {
                create_zip_archive_with_progress(
                    sources,
                    output_path,
                    options.compression_level,
                    &mut progress,
                )
            }
        }
        ArchiveFormat::TarGz => create_tar_archive_with_progress(
            sources,
            output_path,
            true,
            options.compression_level,
            &mut progress,
        ),
        ArchiveFormat::Tar => create_tar_archive_with_progress(
            sources,
            output_path,
            false,
            options.compression_level,
            &mut progress,
        ),
        ArchiveFormat::Rar => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "RAR creation is not supported. RAR is extract-only.",
        )),
        ArchiveFormat::SevenZ => create_7z_archive_with_progress(
            sources,
            output_path,
            options.password.as_deref(),
            &mut progress,
        ),
    }
}

/// Create a password-protected ZIP archive from a list of files/directories
pub fn create_zip_archive_with_password(
    sources: &[PathBuf],
    output_path: &Path,
    compression_level: CompressionLevel,
    password: Option<&str>,
) -> io::Result<u64> {
    let file = File::create(output_path)?;
    let writer = BufWriter::new(file);
    let mut zip = ZipWriter::new(writer);

    let method = match compression_level {
        CompressionLevel::None => CompressionMethod::Stored,
        _ => CompressionMethod::Deflated,
    };

    // Store password as owned String to avoid lifetime issues
    let password_owned = password.map(|p| p.to_string());
    let mut total_bytes: u64 = 0;

    for source in sources {
        if source.is_dir() {
            total_bytes += add_directory_to_zip_with_password(
                &mut zip,
                source,
                source,
                method,
                password_owned.as_deref(),
            )?;
        } else if source.is_file() {
            total_bytes += add_file_to_zip_with_password(
                &mut zip,
                source,
                source.file_name().unwrap().to_str().unwrap(),
                method,
                password_owned.as_deref(),
            )?;
        }
    }

    zip.finish()?;
    Ok(total_bytes)
}

pub fn create_zip_archive_with_password_and_progress(
    sources: &[PathBuf],
    output_path: &Path,
    compression_level: CompressionLevel,
    password: Option<&str>,
    progress: &mut impl FnMut(&Path, u64),
) -> io::Result<u64> {
    let file = File::create(output_path)?;
    let writer = BufWriter::new(file);
    let mut zip = ZipWriter::new(writer);

    let method = match compression_level {
        CompressionLevel::None => CompressionMethod::Stored,
        _ => CompressionMethod::Deflated,
    };

    // Store password as owned String to avoid lifetime issues
    let password_owned = password.map(|p| p.to_string());
    let mut total_bytes: u64 = 0;

    for source in sources {
        if source.is_dir() {
            total_bytes += add_directory_to_zip_with_password_and_progress(
                &mut zip,
                source,
                source,
                method,
                password_owned.as_deref(),
                progress,
            )?;
        } else if source.is_file() {
            total_bytes += add_file_to_zip_with_password_and_progress(
                &mut zip,
                source,
                source.file_name().unwrap().to_str().unwrap(),
                method,
                password_owned.as_deref(),
                progress,
            )?;
        }
    }

    zip.finish()?;
    Ok(total_bytes)
}

fn add_directory_to_zip_with_password_and_progress<W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    dir_path: &Path,
    base_path: &Path,
    method: CompressionMethod,
    password: Option<&str>,
    progress: &mut impl FnMut(&Path, u64),
) -> io::Result<u64> {
    let mut total_bytes: u64 = 0;
    let base_name = base_path
        .file_name()
        .unwrap_or_default()
        .to_str()
        .unwrap_or("");

    for entry in WalkDir::new(dir_path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let relative_path = path.strip_prefix(dir_path).unwrap_or(path);

        // Build the archive path with the base directory name
        let archive_path = if relative_path.as_os_str().is_empty() {
            base_name.to_string()
        } else {
            format!(
                "{}/{}",
                base_name,
                relative_path.to_string_lossy().replace('\\', "/")
            )
        };

        if path.is_dir() {
            // Add directory entry
            let dir_name = format!("{}/", archive_path);
            let options = SimpleFileOptions::default()
                .compression_method(method)
                .unix_permissions(0o755);
            zip.add_directory(&dir_name, options)?;
        } else if path.is_file() {
            total_bytes += add_file_to_zip_with_password_and_progress(
                zip,
                path,
                &archive_path,
                method,
                password,
                progress,
            )?;
        }
    }

    Ok(total_bytes)
}

fn add_file_to_zip_with_password_and_progress<W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    file_path: &Path,
    archive_name: &str,
    method: CompressionMethod,
    password: Option<&str>,
    progress: &mut impl FnMut(&Path, u64),
) -> io::Result<u64> {
    let options = if let Some(pwd) = password {
        SimpleFileOptions::default()
            .compression_method(method)
            .unix_permissions(0o755)
            .with_aes_encryption(zip::AesMode::Aes256, pwd)
    } else {
        SimpleFileOptions::default()
            .compression_method(method)
            .unix_permissions(0o755)
    };

    let size = write_file_to_zip(zip, file_path, archive_name, options)?;
    progress(file_path, size);
    Ok(size)
}

fn add_directory_to_zip_with_password<W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    dir_path: &Path,
    base_path: &Path,
    method: CompressionMethod,
    password: Option<&str>,
) -> io::Result<u64> {
    let mut total_bytes: u64 = 0;
    let base_name = base_path
        .file_name()
        .unwrap_or_default()
        .to_str()
        .unwrap_or("");

    for entry in WalkDir::new(dir_path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let relative_path = path.strip_prefix(dir_path).unwrap_or(path);

        // Build the archive path with the base directory name
        let archive_path = if relative_path.as_os_str().is_empty() {
            base_name.to_string()
        } else {
            format!(
                "{}/{}",
                base_name,
                relative_path.to_string_lossy().replace('\\', "/")
            )
        };

        if path.is_dir() {
            // Add directory entry
            let dir_name = format!("{}/", archive_path);
            let options = SimpleFileOptions::default()
                .compression_method(method)
                .unix_permissions(0o755);
            zip.add_directory(&dir_name, options)?;
        } else if path.is_file() {
            total_bytes +=
                add_file_to_zip_with_password(zip, path, &archive_path, method, password)?;
        }
    }

    Ok(total_bytes)
}

fn add_file_to_zip_with_password<W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    file_path: &Path,
    archive_name: &str,
    method: CompressionMethod,
    password: Option<&str>,
) -> io::Result<u64> {
    let options = if let Some(pwd) = password {
        SimpleFileOptions::default()
            .compression_method(method)
            .unix_permissions(0o755)
            .with_aes_encryption(zip::AesMode::Aes256, pwd)
    } else {
        SimpleFileOptions::default()
            .compression_method(method)
            .unix_permissions(0o755)
    };

    write_file_to_zip(zip, file_path, archive_name, options)
}

/// Check if a file is a supported archive format
pub fn is_archive(path: &Path) -> bool {
    ArchiveFormat::from_path(path).is_some()
}

/// Check if an archive requires a password
pub fn archive_needs_password(archive_path: &Path) -> io::Result<bool> {
    match ArchiveFormat::from_path(archive_path) {
        Some(ArchiveFormat::Zip) => {
            let file = File::open(archive_path)?;
            let reader = BufReader::new(file);
            let mut archive = ZipArchive::new(reader)?;
            // Check if any file in the archive is encrypted
            for i in 0..archive.len() {
                if let Ok(file) = archive.by_index_raw(i)
                    && file.encrypted()
                {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Some(ArchiveFormat::Rar) => {
            // RAR archives - check via unrar
            let archive = unrar::Archive::new(archive_path)
                .open_for_listing()
                .map_err(|e| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("Failed to open RAR: {:?}", e),
                    )
                })?;

            for entry in archive.flatten() {
                if entry.is_encrypted() {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Some(ArchiveFormat::SevenZ) => {
            // For 7z, try opening without password; if it fails, assume password needed
            let file = File::open(archive_path)?;
            let len = file.metadata()?.len();
            let reader = BufReader::new(file);
            match sevenz_rust::SevenZReader::new(reader, len, sevenz_rust::Password::empty()) {
                Ok(_) => Ok(false),
                Err(_) => Ok(true), // Assume password needed if can't open
            }
        }
        Some(ArchiveFormat::TarGz) | Some(ArchiveFormat::Tar) => {
            // TAR archives don't support encryption
            Ok(false)
        }
        None => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Unsupported archive format",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn test_archive_format_detection() {
        assert_eq!(
            ArchiveFormat::from_path(Path::new("test.zip")),
            Some(ArchiveFormat::Zip)
        );
        assert_eq!(
            ArchiveFormat::from_path(Path::new("test.tar.gz")),
            Some(ArchiveFormat::TarGz)
        );
        assert_eq!(
            ArchiveFormat::from_path(Path::new("test.tgz")),
            Some(ArchiveFormat::TarGz)
        );
        assert_eq!(
            ArchiveFormat::from_path(Path::new("test.tar")),
            Some(ArchiveFormat::Tar)
        );
        assert_eq!(ArchiveFormat::from_path(Path::new("test.txt")), None);
    }

    #[test]
    fn test_create_and_extract_zip() {
        let temp_dir = TempDir::new().unwrap();
        let source_dir = temp_dir.path().join("source");
        fs::create_dir(&source_dir).unwrap();

        // Create test file
        let test_file = source_dir.join("test.txt");
        let mut file = File::create(&test_file).unwrap();
        file.write_all(b"Hello, World!").unwrap();

        // Create archive
        let archive_path = temp_dir.path().join("test.zip");
        let sources = vec![source_dir.clone()];
        create_zip_archive(&sources, &archive_path, CompressionLevel::Normal).unwrap();

        // Extract archive
        let extract_dir = temp_dir.path().join("extracted");
        extract_zip_archive(&archive_path, &extract_dir).unwrap();

        // Verify extraction
        let extracted_file = extract_dir.join("source/test.txt");
        assert!(extracted_file.exists());
        let content = fs::read_to_string(&extracted_file).unwrap();
        assert_eq!(content, "Hello, World!");
    }

    #[test]
    fn test_create_and_extract_zip_with_password() {
        let temp_dir = TempDir::new().unwrap();
        let source_dir = temp_dir.path().join("source");
        fs::create_dir(&source_dir).unwrap();

        let test_file = source_dir.join("secret.txt");
        let mut file = File::create(&test_file).unwrap();
        file.write_all(b"Top secret").unwrap();

        let archive_path = temp_dir.path().join("secret.zip");
        let sources = vec![source_dir.clone()];
        create_zip_archive_with_password(
            &sources,
            &archive_path,
            CompressionLevel::Normal,
            Some("password123"),
        )
        .unwrap();

        assert!(archive_needs_password(&archive_path).unwrap());

        let wrong_extract_dir = temp_dir.path().join("wrong_extract");
        let wrong_result =
            extract_zip_archive_with_password(&archive_path, &wrong_extract_dir, Some("wrong"));
        assert!(wrong_result.is_err());

        let extract_dir = temp_dir.path().join("extracted");
        extract_zip_archive_with_password(&archive_path, &extract_dir, Some("password123"))
            .unwrap();

        let extracted_file = extract_dir.join("source/secret.txt");
        let content = fs::read_to_string(&extracted_file).unwrap();
        assert_eq!(content, "Top secret");
    }

    #[test]
    fn test_zip_large_file_handling() {
        let temp_dir = TempDir::new().unwrap();
        let source_dir = temp_dir.path().join("source");
        fs::create_dir(&source_dir).unwrap();

        let file_size = 2 * 1024 * 1024;
        let payload: Vec<u8> = (0..file_size).map(|i| (i % 251) as u8).collect();

        let large_file = source_dir.join("large.bin");
        let mut file = File::create(&large_file).unwrap();
        file.write_all(&payload).unwrap();

        let archive_path = temp_dir.path().join("large.zip");
        let sources = vec![source_dir.clone()];
        create_zip_archive(&sources, &archive_path, CompressionLevel::Normal).unwrap();

        let extract_dir = temp_dir.path().join("extracted");
        extract_zip_archive(&archive_path, &extract_dir).unwrap();

        let extracted_file = extract_dir.join("source/large.bin");
        let extracted_payload = fs::read(&extracted_file).unwrap();
        assert_eq!(extracted_payload.len(), payload.len());
        assert_eq!(extracted_payload, payload);
    }

    #[test]
    fn test_zip_unicode_filenames() {
        let temp_dir = TempDir::new().unwrap();
        let source_dir = temp_dir.path().join("source");
        fs::create_dir(&source_dir).unwrap();

        let file_name = "unicode_\u{00E9}_\u{03B1}.txt";
        let test_file = source_dir.join(file_name);
        let mut file = File::create(&test_file).unwrap();
        file.write_all(b"Unicode content").unwrap();

        let archive_path = temp_dir.path().join("unicode.zip");
        let sources = vec![source_dir.clone()];
        create_zip_archive(&sources, &archive_path, CompressionLevel::Normal).unwrap();

        let extract_dir = temp_dir.path().join("extracted");
        extract_zip_archive(&archive_path, &extract_dir).unwrap();

        let extracted_file = extract_dir.join("source").join(file_name);
        let content = fs::read_to_string(&extracted_file).unwrap();
        assert_eq!(content, "Unicode content");
    }

    #[cfg(unix)]
    #[test]
    fn test_zip_symlink_handling() {
        use std::os::unix::fs::symlink;

        let temp_dir = TempDir::new().unwrap();
        let source_dir = temp_dir.path().join("source");
        fs::create_dir(&source_dir).unwrap();

        let target_file = source_dir.join("target.txt");
        let mut file = File::create(&target_file).unwrap();
        file.write_all(b"Symlink target").unwrap();

        let link_path = source_dir.join("link.txt");
        symlink(&target_file, &link_path).unwrap();

        let archive_path = temp_dir.path().join("symlink.zip");
        let sources = vec![source_dir.clone()];
        create_zip_archive(&sources, &archive_path, CompressionLevel::Normal).unwrap();

        let extract_dir = temp_dir.path().join("extracted");
        extract_zip_archive(&archive_path, &extract_dir).unwrap();

        let extracted_file = extract_dir.join("source/link.txt");
        let content = fs::read_to_string(&extracted_file).unwrap();
        assert_eq!(content, "Symlink target");
    }

    #[test]
    fn test_zip_corrupted_archive_handling() {
        let temp_dir = TempDir::new().unwrap();
        let archive_path = temp_dir.path().join("corrupt.zip");
        let mut file = File::create(&archive_path).unwrap();
        file.write_all(b"not a zip").unwrap();

        let extract_dir = temp_dir.path().join("extracted");
        let result = extract_zip_archive(&archive_path, &extract_dir);
        assert!(result.is_err());
    }
}
