use crc32fast::Hasher;
use gamut_iptc::{IimBlock, IimCharset, IimDataSet, IimTagInfo, IrbBlock, PhotoshopIrb};
use little_exif::endian::Endian;
use little_exif::exif_tag::ExifTag;
use little_exif::exif_tag_format::ExifTagFormat;
use little_exif::filetype::FileExtension;
use little_exif::ifd::ExifTagGroup;
use little_exif::metadata::Metadata as ExifMetadata;
use little_exif::rational::uR64;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use uuid::Uuid;

#[cfg(unix)]
use std::fs::File;

const IPTC_TIFF_TAG: u16 = 0x83bb;
const IPTC_PNG_KEY: &[u8] = b"IPTC";
const IPTC_RAW_PROFILE_KEY: &[u8] = b"Raw profile type iptc";
const PHOTOSHOP_HEADER: &[u8] = b"Photoshop 3.0\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImageFormat {
    Jpeg,
    Png,
    Tiff,
}

impl ImageFormat {
    fn file_type(self) -> FileExtension {
        match self {
            Self::Jpeg => FileExtension::JPEG,
            Self::Png => FileExtension::PNG {
                as_zTXt_chunk: true,
            },
            Self::Tiff => FileExtension::TIFF,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Jpeg => "JPEG",
            Self::Png => "PNG",
            Self::Tiff => "TIFF",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMetadata {
    pub format: String,
    /// False when the file carries no EXIF/IPTC-capable container, so callers
    /// can render an empty state instead of an error.
    pub supported: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub exif: Vec<MetadataField>,
    pub iptc: Vec<MetadataField>,
}

impl ImageMetadata {
    fn unsupported() -> Self {
        Self {
            format: "Unsupported".to_string(),
            supported: false,
            width: None,
            height: None,
            exif: Vec::new(),
            iptc: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataField {
    pub key: String,
    pub label: String,
    pub value: String,
    pub editable: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataUpdate {
    pub key: String,
    pub value: String,
}

pub fn read(path: &Path) -> io::Result<ImageMetadata> {
    let bytes = fs::read(path)?;
    let Some(format) = detect_format(&bytes) else {
        return Ok(ImageMetadata::unsupported());
    };
    let exif = read_exif(&bytes, format.file_type())?;
    let iptc = extract_iptc_block(format, &bytes, &exif)?;
    let dimensions = pixel_dimensions(format, &bytes, &exif);
    Ok(to_image_metadata(format, dimensions, &exif, iptc.as_ref()))
}

pub fn write(path: &Path, updates: &[MetadataUpdate]) -> io::Result<ImageMetadata> {
    if updates.is_empty() {
        return read(path);
    }

    let bytes = fs::read(path)?;
    let (format, file_type) = detect_writable_format(path, &bytes)?;
    let mut exif = read_exif(&bytes, file_type)?;
    let mut iptc = extract_iptc_block(format, &bytes, &exif)?;
    let mut has_exif_update = false;
    let mut has_iptc_update = false;

    for update in updates {
        validate_update(update)?;
        if update.key.starts_with("exif:") {
            update_exif(&mut exif, &update.key, &update.value)?;
            has_exif_update = true;
        } else if update.key.starts_with("iptc:") {
            update_iptc(&mut iptc, &update.key, &update.value)?;
            has_iptc_update = true;
        } else {
            return invalid_data(format!("Unsupported image metadata field: {}", update.key));
        }
    }

    let iptc_bytes = if has_iptc_update {
        iptc.as_ref()
            .filter(|block| has_iptc_content(block))
            .map(|block| {
                block
                    .encode()
                    .map_err(|error| invalid_error(error.to_string()))
            })
            .transpose()?
    } else {
        None
    };

    if format == ImageFormat::Tiff && has_iptc_update {
        exif.remove_tag_by_hex_group(IPTC_TIFF_TAG, ExifTagGroup::GENERIC);
        if let Some(bytes) = iptc_bytes.as_ref() {
            exif.set_tag(ExifTag::UnknownUNDEF(
                bytes.clone(),
                IPTC_TIFF_TAG,
                ExifTagGroup::GENERIC,
            ));
        }
    }

    let mut output = bytes;
    if has_exif_update || (format == ImageFormat::Tiff && has_iptc_update) {
        if format == ImageFormat::Tiff {
            ensure_tiff_required_tags(&mut exif);
        }
        exif.write_to_vec(&mut output, file_type)
            .map_err(|error| invalid_error(format!("Could not write EXIF data: {error}")))?;
    }
    if has_iptc_update && format != ImageFormat::Tiff {
        output = match format {
            ImageFormat::Jpeg => write_jpeg_iptc(&output, iptc_bytes.as_deref())?,
            ImageFormat::Png => write_png_iptc(&output, iptc_bytes.as_deref())?,
            ImageFormat::Tiff => output,
        };
    }

    atomic_write(path, &output)?;
    read(path)
}

fn detect_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(ImageFormat::Jpeg)
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageFormat::Png)
    } else if bytes.starts_with(b"II\x2a\0") || bytes.starts_with(b"MM\0\x2a") {
        Some(ImageFormat::Tiff)
    } else {
        None
    }
}

fn detect_writable_format(path: &Path, bytes: &[u8]) -> io::Result<(ImageFormat, FileExtension)> {
    let Some(format) = detect_format(bytes) else {
        return invalid_data(format!(
            "Unsupported or invalid image format: {}",
            path.display()
        ));
    };

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension_matches = match format {
        ImageFormat::Jpeg => matches!(extension.as_str(), "jpg" | "jpeg"),
        ImageFormat::Png => extension == "png",
        ImageFormat::Tiff => matches!(extension.as_str(), "tif" | "tiff"),
    };
    if !extension_matches && !extension.is_empty() {
        return invalid_data(format!(
            "Image extension does not match its contents: {}",
            path.display()
        ));
    }
    Ok((format, format.file_type()))
}

fn read_exif(bytes: &[u8], file_type: FileExtension) -> io::Result<ExifMetadata> {
    ExifMetadata::new_from_vec(&bytes.to_vec(), file_type).or_else(|_| Ok(ExifMetadata::new()))
}

/// Pixel dimensions come from the image container itself, not from EXIF, so
/// they are reported even for files that carry no metadata at all.
fn pixel_dimensions(format: ImageFormat, bytes: &[u8], exif: &ExifMetadata) -> Option<(u32, u32)> {
    match format {
        ImageFormat::Jpeg => jpeg_dimensions(bytes),
        ImageFormat::Png => png_dimensions(bytes),
        ImageFormat::Tiff => tiff_dimensions(exif),
    }
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    for segment in jpeg_segments(bytes).ok()? {
        let is_frame_header = (0xc0..=0xcf).contains(&segment.marker)
            && !matches!(segment.marker, 0xc4 | 0xc8 | 0xcc);
        if !is_frame_header || segment.payload.len() < 5 {
            continue;
        }
        let height = u16::from_be_bytes([segment.payload[1], segment.payload[2]]);
        let width = u16::from_be_bytes([segment.payload[3], segment.payload[4]]);
        return Some((width as u32, height as u32));
    }
    None
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let chunk = png_chunks(bytes)
        .ok()?
        .into_iter()
        .find(|chunk| chunk.kind == *b"IHDR")?;
    if chunk.data.len() < 8 {
        return None;
    }
    Some((
        u32::from_be_bytes(chunk.data[..4].try_into().ok()?),
        u32::from_be_bytes(chunk.data[4..8].try_into().ok()?),
    ))
}

fn tiff_dimensions(exif: &ExifMetadata) -> Option<(u32, u32)> {
    let endian = exif.get_endian();
    let value_of = |wanted: u16| {
        exif.get_ifds()
            .iter()
            .filter(|ifd| matches!(ifd.get_ifd_type(), ExifTagGroup::GENERIC))
            .flat_map(|ifd| ifd.get_tags())
            .find(|tag| tag.as_u16() == wanted)
            .and_then(|tag| scalar_u32(tag, &endian))
    };
    Some((value_of(0x0100)?, value_of(0x0101)?))
}

fn scalar_u32(tag: &ExifTag, endian: &Endian) -> Option<u32> {
    let raw = tag.value_as_u8_vec(endian);
    match tag.format() {
        ExifTagFormat::INT16U if raw.len() >= 2 => Some(read_u16(&raw[..2], endian) as u32),
        ExifTagFormat::INT32U if raw.len() >= 4 => Some(read_u32(&raw[..4], endian)),
        _ => None,
    }
}

/// `little_exif` requires the three TIFF resolution tags when it re-encodes a
/// TIFF, even though they are optional for a valid image. Keep existing values
/// intact and supply a conventional 72 DPI fallback only for missing tags.
fn ensure_tiff_required_tags(exif: &mut ExifMetadata) {
    let has_x_resolution = exif
        .get_tag_by_hex(0x011a, Some(ExifTagGroup::GENERIC))
        .next()
        .is_some();
    let has_y_resolution = exif
        .get_tag_by_hex(0x011b, Some(ExifTagGroup::GENERIC))
        .next()
        .is_some();
    let has_resolution_unit = exif
        .get_tag_by_hex(0x0128, Some(ExifTagGroup::GENERIC))
        .next()
        .is_some();

    if !has_x_resolution {
        exif.set_tag(ExifTag::XResolution(vec![uR64 {
            nominator: 72,
            denominator: 1,
        }]));
    }
    if !has_y_resolution {
        exif.set_tag(ExifTag::YResolution(vec![uR64 {
            nominator: 72,
            denominator: 1,
        }]));
    }
    if !has_resolution_unit {
        exif.set_tag(ExifTag::ResolutionUnit(vec![2]));
    }
}

fn to_image_metadata(
    format: ImageFormat,
    dimensions: Option<(u32, u32)>,
    exif: &ExifMetadata,
    iptc: Option<&IimBlock>,
) -> ImageMetadata {
    let mut exif_fields = Vec::new();
    for ifd in exif.get_ifds() {
        for tag in ifd.get_tags() {
            if tag.as_u16() == IPTC_TIFF_TAG || !tag.is_writable() {
                continue;
            }
            let group = ifd.get_ifd_type();
            exif_fields.push(MetadataField {
                key: format!("exif:{}:{:04X}", group_name(group), tag.as_u16()),
                label: exif_label(group, tag.as_u16()),
                value: format_exif_value(tag, &exif.get_endian()),
                editable: exif_update_tag(group, tag.as_u16()).is_some(),
            });
        }
    }
    exif_fields.sort_by(|left, right| left.key.cmp(&right.key));

    let iptc_fields = iptc.map(to_iptc_fields).unwrap_or_default();
    ImageMetadata {
        format: format.label().to_string(),
        supported: true,
        width: dimensions.map(|(width, _)| width),
        height: dimensions.map(|(_, height)| height),
        exif: exif_fields,
        iptc: iptc_fields,
    }
}

fn group_name(group: ExifTagGroup) -> &'static str {
    match group {
        ExifTagGroup::GENERIC => "GENERIC",
        ExifTagGroup::EXIF => "EXIF",
        ExifTagGroup::GPS => "GPS",
        ExifTagGroup::INTEROP => "INTEROP",
    }
}

fn parse_group(value: &str) -> Option<ExifTagGroup> {
    match value {
        "GENERIC" => Some(ExifTagGroup::GENERIC),
        "EXIF" => Some(ExifTagGroup::EXIF),
        "GPS" => Some(ExifTagGroup::GPS),
        "INTEROP" => Some(ExifTagGroup::INTEROP),
        _ => None,
    }
}

fn exif_label(group: ExifTagGroup, tag: u16) -> String {
    let label = match (group, tag) {
        (ExifTagGroup::GENERIC, 0x0100) => "Image Width",
        (ExifTagGroup::GENERIC, 0x0101) => "Image Height",
        (ExifTagGroup::GENERIC, 0x010e) => "Image Description",
        (ExifTagGroup::GENERIC, 0x010f) => "Make",
        (ExifTagGroup::GENERIC, 0x0110) => "Model",
        (ExifTagGroup::GENERIC, 0x0112) => "Orientation",
        (ExifTagGroup::GENERIC, 0x011a) => "X Resolution",
        (ExifTagGroup::GENERIC, 0x011b) => "Y Resolution",
        (ExifTagGroup::GENERIC, 0x0131) => "Software",
        (ExifTagGroup::GENERIC, 0x0132) => "Modify Date",
        (ExifTagGroup::GENERIC, 0x013b) => "Artist",
        (ExifTagGroup::GENERIC, 0x8298) => "Copyright",
        (ExifTagGroup::EXIF, 0x829a) => "Exposure Time",
        (ExifTagGroup::EXIF, 0x829d) => "F-Number",
        (ExifTagGroup::EXIF, 0x8827) => "ISO",
        (ExifTagGroup::EXIF, 0x9003) => "Date/Time Original",
        (ExifTagGroup::EXIF, 0x9004) => "Create Date",
        (ExifTagGroup::EXIF, 0x9204) => "Exposure Compensation",
        (ExifTagGroup::EXIF, 0x920a) => "Focal Length",
        (ExifTagGroup::EXIF, 0xa002) => "Exif Image Width",
        (ExifTagGroup::EXIF, 0xa003) => "Exif Image Height",
        (ExifTagGroup::EXIF, 0xa431) => "Serial Number",
        (ExifTagGroup::EXIF, 0xa432) => "Lens Info",
        (ExifTagGroup::EXIF, 0xa433) => "Lens Make",
        (ExifTagGroup::EXIF, 0xa434) => "Lens Model",
        (ExifTagGroup::GPS, 0x0001) => "GPS Latitude Reference",
        (ExifTagGroup::GPS, 0x0002) => "GPS Latitude",
        (ExifTagGroup::GPS, 0x0003) => "GPS Longitude Reference",
        (ExifTagGroup::GPS, 0x0004) => "GPS Longitude",
        (ExifTagGroup::GPS, 0x0006) => "GPS Altitude",
        (ExifTagGroup::GPS, 0x001d) => "GPS Date Stamp",
        _ => return format!("{} 0x{:04X}", group_name(group), tag),
    };
    label.to_string()
}

fn exif_update_tag(group: ExifTagGroup, tag: u16) -> Option<&'static str> {
    match (group, tag) {
        (ExifTagGroup::GENERIC, 0x010e) => Some("Image Description"),
        (ExifTagGroup::GENERIC, 0x010f) => Some("Make"),
        (ExifTagGroup::GENERIC, 0x0110) => Some("Model"),
        (ExifTagGroup::GENERIC, 0x0131) => Some("Software"),
        (ExifTagGroup::GENERIC, 0x0132) => Some("Modify Date"),
        (ExifTagGroup::GENERIC, 0x013b) => Some("Artist"),
        (ExifTagGroup::GENERIC, 0x8298) => Some("Copyright"),
        (ExifTagGroup::EXIF, 0x9003) => Some("Date/Time Original"),
        (ExifTagGroup::EXIF, 0x9004) => Some("Create Date"),
        _ => None,
    }
}

fn update_exif(exif: &mut ExifMetadata, key: &str, value: &str) -> io::Result<()> {
    let mut parts = key.split(':');
    let (_, group_value, tag_value) = (parts.next(), parts.next(), parts.next());
    if parts.next().is_some() {
        return invalid_data(format!("Invalid EXIF field key: {key}"));
    }
    let group = group_value.and_then(parse_group);
    let tag = tag_value.and_then(|value| u16::from_str_radix(value, 16).ok());
    let (Some(group), Some(tag)) = (group, tag) else {
        return invalid_data(format!("Invalid EXIF field key: {key}"));
    };
    if exif_update_tag(group, tag).is_none() {
        return invalid_data(format!("EXIF field is read-only: {key}"));
    }
    exif.remove_tag_by_hex_group(tag, group);
    if value.is_empty() {
        return Ok(());
    }
    let tag = match (group, tag) {
        (ExifTagGroup::GENERIC, 0x010e) => ExifTag::ImageDescription(value.to_owned()),
        (ExifTagGroup::GENERIC, 0x010f) => ExifTag::Make(value.to_owned()),
        (ExifTagGroup::GENERIC, 0x0110) => ExifTag::Model(value.to_owned()),
        (ExifTagGroup::GENERIC, 0x0131) => ExifTag::Software(value.to_owned()),
        (ExifTagGroup::GENERIC, 0x0132) => ExifTag::ModifyDate(value.to_owned()),
        (ExifTagGroup::GENERIC, 0x013b) => ExifTag::Artist(value.to_owned()),
        (ExifTagGroup::GENERIC, 0x8298) => ExifTag::Copyright(value.to_owned()),
        (ExifTagGroup::EXIF, 0x9003) => ExifTag::DateTimeOriginal(value.to_owned()),
        (ExifTagGroup::EXIF, 0x9004) => ExifTag::CreateDate(value.to_owned()),
        _ => return invalid_data(format!("Unsupported EXIF field: {key}")),
    };
    exif.set_tag(tag);
    Ok(())
}

fn format_exif_value(tag: &ExifTag, endian: &Endian) -> String {
    let raw = tag.value_as_u8_vec(endian);
    if tag.is_string() {
        return trim_value(String::from_utf8_lossy(&raw).into_owned());
    }
    match tag.format() {
        ExifTagFormat::INT8U | ExifTagFormat::INT8S => format_numbers(&raw, 1, endian, false),
        ExifTagFormat::INT16U => format_numbers(&raw, 2, endian, false),
        ExifTagFormat::INT16S => format_numbers(&raw, 2, endian, true),
        ExifTagFormat::INT32U => format_numbers(&raw, 4, endian, false),
        ExifTagFormat::INT32S => format_numbers(&raw, 4, endian, true),
        ExifTagFormat::RATIONAL64U | ExifTagFormat::RATIONAL64S => {
            let values = raw
                .chunks_exact(8)
                .map(|chunk| {
                    let numerator = read_u32(&chunk[..4], endian);
                    let denominator = read_u32(&chunk[4..], endian);
                    format!("{numerator}/{denominator}")
                })
                .collect::<Vec<_>>();
            values.join(", ")
        }
        ExifTagFormat::UNDEF => printable_or_hex(&raw),
        ExifTagFormat::FLOAT | ExifTagFormat::DOUBLE => printable_or_hex(&raw),
        ExifTagFormat::STRING => trim_value(String::from_utf8_lossy(&raw).into_owned()),
    }
}

fn format_numbers(raw: &[u8], width: usize, endian: &Endian, signed: bool) -> String {
    raw.chunks_exact(width)
        .map(|chunk| match width {
            1 => {
                if signed {
                    (chunk[0] as i8).to_string()
                } else {
                    chunk[0].to_string()
                }
            }
            2 => {
                let value = read_u16(chunk, endian);
                if signed {
                    (value as i16).to_string()
                } else {
                    value.to_string()
                }
            }
            _ => {
                let value = read_u32(chunk, endian);
                if signed {
                    (value as i32).to_string()
                } else {
                    value.to_string()
                }
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn read_u16(bytes: &[u8], endian: &Endian) -> u16 {
    match endian {
        Endian::Little => u16::from_le_bytes([bytes[0], bytes[1]]),
        Endian::Big => u16::from_be_bytes([bytes[0], bytes[1]]),
    }
}

fn read_u32(bytes: &[u8], endian: &Endian) -> u32 {
    match endian {
        Endian::Little => u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        Endian::Big => u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
    }
}

fn printable_or_hex(bytes: &[u8]) -> String {
    if bytes
        .iter()
        .all(|byte| byte.is_ascii_graphic() || byte.is_ascii_whitespace())
    {
        trim_value(String::from_utf8_lossy(bytes).into_owned())
    } else {
        bytes
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn trim_value(value: String) -> String {
    value.trim_end_matches('\0').to_string()
}

fn extract_iptc_block(
    format: ImageFormat,
    bytes: &[u8],
    exif: &ExifMetadata,
) -> io::Result<Option<IimBlock>> {
    let raw = match format {
        ImageFormat::Jpeg => extract_jpeg_iptc(bytes)?,
        ImageFormat::Png => extract_png_iptc(bytes)?,
        ImageFormat::Tiff => extract_tiff_iptc(exif),
    };
    raw.map(|bytes| {
        IimBlock::parse(&bytes)
            .map_err(|error| invalid_error(format!("Could not parse IPTC data: {error}")))
    })
    .transpose()
}

fn extract_tiff_iptc(exif: &ExifMetadata) -> Option<Vec<u8>> {
    exif.get_ifds()
        .iter()
        .flat_map(|ifd| ifd.get_tags())
        .find(|tag| tag.as_u16() == IPTC_TIFF_TAG)
        .map(|tag| tag.value_as_u8_vec(&exif.get_endian()))
}

fn to_iptc_fields(block: &IimBlock) -> Vec<MetadataField> {
    let charset = IimCharset::detect(block).unwrap_or(IimCharset::Latin1);
    let mut grouped: BTreeMap<(u8, u8), Vec<String>> = BTreeMap::new();
    for dataset in &block.datasets {
        if dataset.record != 2 || dataset.dataset == 0 {
            continue;
        }
        let value = charset
            .decode(&dataset.data)
            .unwrap_or_else(|_| printable_or_hex(&dataset.data));
        grouped
            .entry((dataset.record, dataset.dataset))
            .or_default()
            .push(value);
    }
    grouped
        .into_iter()
        .filter_map(|((record, dataset), values)| {
            let info = IimTagInfo::lookup(record, dataset)?;
            let value = if info.repeatable {
                values.join(", ")
            } else {
                values.into_iter().next().unwrap_or_default()
            };
            Some(MetadataField {
                key: format!("iptc:{record}:{dataset}"),
                label: info.name.to_string(),
                value,
                editable: true,
            })
        })
        .collect()
}

fn update_iptc(block: &mut Option<IimBlock>, key: &str, value: &str) -> io::Result<()> {
    let mut parts = key.split(':');
    let (_, record, dataset) = (parts.next(), parts.next(), parts.next());
    if parts.next().is_some() {
        return invalid_data(format!("Invalid IPTC field key: {key}"));
    }
    let record = record.and_then(|value| value.parse::<u8>().ok());
    let dataset = dataset.and_then(|value| value.parse::<u8>().ok());
    let (Some(record), Some(dataset)) = (record, dataset) else {
        return invalid_data(format!("Invalid IPTC field key: {key}"));
    };
    let Some(info) = IimTagInfo::lookup(record, dataset) else {
        return invalid_data(format!("Unsupported IPTC field: {key}"));
    };
    if record != 2 || dataset == 0 {
        return invalid_data(format!("IPTC field is read-only: {key}"));
    }

    let current = block.get_or_insert_with(IimBlock::default);
    let charset = IimCharset::detect(current).unwrap_or(IimCharset::Latin1);
    current
        .datasets
        .retain(|item| !(item.record == record && item.dataset == dataset));
    if value.is_empty() {
        return Ok(());
    }

    let values = if info.repeatable {
        value
            .split([',', '\n'])
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
    } else {
        vec![value.trim()]
    };
    let use_utf8 = charset == IimCharset::Utf8
        || values
            .iter()
            .any(|value| value.chars().any(|c| c as u32 > 0xff));
    let charset = if use_utf8 { IimCharset::Utf8 } else { charset };
    current
        .datasets
        .retain(|item| !(item.record == 1 && item.dataset == 90));
    if let Some(escape) = charset.escape_sequence() {
        current.datasets.insert(
            0,
            IimDataSet {
                record: 1,
                dataset: 90,
                data: escape.to_vec(),
            },
        );
    }
    for value in values {
        let data = charset
            .encode(value)
            .map_err(|error| invalid_error(error.to_string()))?;
        if data.len() > info.max_octets as usize {
            return invalid_data(format!("IPTC value for {} is too long", info.name));
        }
        current.datasets.push(IimDataSet {
            record,
            dataset,
            data,
        });
    }
    Ok(())
}

fn has_iptc_content(block: &IimBlock) -> bool {
    block
        .datasets
        .iter()
        .any(|dataset| dataset.record == 2 && dataset.dataset != 0)
}

fn validate_update(update: &MetadataUpdate) -> io::Result<()> {
    if update.key.len() > 128 || update.value.len() > 64 * 1024 || update.value.contains('\0') {
        return invalid_data(
            "Image metadata update is too large or contains a NUL byte".to_string(),
        );
    }
    Ok(())
}

fn extract_jpeg_iptc(bytes: &[u8]) -> io::Result<Option<Vec<u8>>> {
    for segment in jpeg_segments(bytes)? {
        if segment.marker != 0xed || !segment.payload.starts_with(PHOTOSHOP_HEADER) {
            continue;
        }
        let irb =
            PhotoshopIrb::parse(&segment.payload[PHOTOSHOP_HEADER.len()..]).map_err(|error| {
                invalid_error(format!("Could not parse JPEG IPTC resource: {error}"))
            })?;
        if let Some(data) = irb.iptc_iim() {
            return Ok(Some(data.to_vec()));
        }
    }
    Ok(None)
}

#[derive(Clone, Copy)]
struct JpegSegment<'a> {
    start: usize,
    end: usize,
    marker: u8,
    payload: &'a [u8],
}

fn jpeg_segments(bytes: &[u8]) -> io::Result<Vec<JpegSegment<'_>>> {
    if bytes.len() < 2 || bytes[..2] != [0xff, 0xd8] {
        return invalid_data("Invalid JPEG header".to_string());
    }
    let mut segments = Vec::new();
    let mut position = 2;
    while position < bytes.len() {
        let start = position;
        if bytes[position] != 0xff {
            break;
        }
        while position < bytes.len() && bytes[position] == 0xff {
            position += 1;
        }
        let marker = *bytes
            .get(position)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Truncated JPEG marker"))?;
        position += 1;
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length = u16::from_be_bytes([
            *bytes.get(position).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "Truncated JPEG segment")
            })?,
            *bytes.get(position + 1).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "Truncated JPEG segment")
            })?,
        ]) as usize;
        if length < 2 {
            return invalid_data("Invalid JPEG segment length".to_string());
        }
        let end = position
            .checked_add(length)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "JPEG segment overflow"))?;
        if end > bytes.len() {
            return invalid_data("Truncated JPEG segment".to_string());
        }
        segments.push(JpegSegment {
            start,
            end,
            marker,
            payload: &bytes[position + 2..end],
        });
        position = end;
    }
    Ok(segments)
}

fn write_jpeg_iptc(bytes: &[u8], iptc: Option<&[u8]>) -> io::Result<Vec<u8>> {
    let segments = jpeg_segments(bytes)?;
    let mut output = Vec::with_capacity(bytes.len() + iptc.map_or(0, |value| value.len() + 32));
    output.extend_from_slice(&bytes[..2]);
    let mut inserted = false;
    let mut insert_before = true;

    for segment in &segments {
        let is_photoshop = segment.marker == 0xed && segment.payload.starts_with(PHOTOSHOP_HEADER);
        if is_photoshop {
            let irb = PhotoshopIrb::parse(&segment.payload[PHOTOSHOP_HEADER.len()..]).map_err(
                |error| invalid_error(format!("Could not parse JPEG IPTC resource: {error}")),
            )?;
            if irb.iptc_iim().is_some() {
                if !inserted {
                    if let Some(payload) = updated_photoshop_payload(irb, iptc)? {
                        write_jpeg_segment(&mut output, 0xed, &payload)?;
                    }
                    inserted = true;
                }
                continue;
            }
        }
        if insert_before
            && !inserted
            && let Some(iptc) = iptc
        {
            write_jpeg_segment(&mut output, 0xed, &new_photoshop_payload(iptc)?)?;
            inserted = true;
        }
        output.extend_from_slice(&bytes[segment.start..segment.end]);
        insert_before = false;
    }
    if !inserted && let Some(iptc) = iptc {
        write_jpeg_segment(&mut output, 0xed, &new_photoshop_payload(iptc)?)?;
    }
    let last_end = segments.last().map(|segment| segment.end).unwrap_or(2);
    if last_end < bytes.len() {
        output.extend_from_slice(&bytes[last_end..]);
    }
    Ok(output)
}

fn new_photoshop_payload(iptc: &[u8]) -> io::Result<Vec<u8>> {
    let irb = PhotoshopIrb::with_iptc(iptc.to_vec());
    let mut payload = PHOTOSHOP_HEADER.to_vec();
    payload.extend(
        irb.encode()
            .map_err(|error| invalid_error(error.to_string()))?,
    );
    Ok(payload)
}

fn updated_photoshop_payload(
    mut irb: PhotoshopIrb,
    iptc: Option<&[u8]>,
) -> io::Result<Option<Vec<u8>>> {
    irb.blocks.retain(|block| block.resource_id != 0x0404);
    if let Some(iptc) = iptc {
        irb.blocks.push(IrbBlock {
            resource_id: 0x0404,
            name: String::new(),
            data: iptc.to_vec(),
        });
    }
    if irb.blocks.is_empty() {
        return Ok(None);
    }
    let mut payload = PHOTOSHOP_HEADER.to_vec();
    payload.extend(
        irb.encode()
            .map_err(|error| invalid_error(error.to_string()))?,
    );
    Ok(Some(payload))
}

fn write_jpeg_segment(output: &mut Vec<u8>, marker: u8, payload: &[u8]) -> io::Result<()> {
    let length = payload.len() + 2;
    if length > u16::MAX as usize {
        return invalid_data("IPTC data is too large for a JPEG APP13 segment".to_string());
    }
    output.extend_from_slice(&[0xff, marker]);
    output.extend_from_slice(&(length as u16).to_be_bytes());
    output.extend_from_slice(payload);
    Ok(())
}

#[derive(Clone, Copy)]
struct PngChunk<'a> {
    start: usize,
    end: usize,
    kind: [u8; 4],
    data: &'a [u8],
}

fn png_chunks(bytes: &[u8]) -> io::Result<Vec<PngChunk<'_>>> {
    const SIGNATURE_LEN: usize = 8;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return invalid_data("Invalid PNG header".to_string());
    }
    let mut chunks = Vec::new();
    let mut position = SIGNATURE_LEN;
    while position + 12 <= bytes.len() {
        let start = position;
        let length = u32::from_be_bytes(bytes[position..position + 4].try_into().unwrap()) as usize;
        let data_start = position + 8;
        let data_end = data_start
            .checked_add(length)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "PNG chunk overflow"))?;
        let end = data_end
            .checked_add(4)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "PNG chunk overflow"))?;
        if end > bytes.len() {
            return invalid_data("Truncated PNG chunk".to_string());
        }
        let kind = bytes[position + 4..position + 8].try_into().unwrap();
        chunks.push(PngChunk {
            start,
            end,
            kind,
            data: &bytes[data_start..data_end],
        });
        position = end;
        if kind == *b"IEND" {
            return Ok(chunks);
        }
    }
    invalid_data("PNG is missing its IEND chunk".to_string())
}

fn extract_png_iptc(bytes: &[u8]) -> io::Result<Option<Vec<u8>>> {
    for chunk in png_chunks(bytes)? {
        if chunk.kind != *b"tEXt" && chunk.kind != *b"iTXt" {
            continue;
        }
        if let Some(text) = png_metadata_text(chunk.kind, chunk.data)
            && is_iptc_key(text.0)
            && let Some(bytes) = decode_raw_profile(text.1)
        {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

fn png_metadata_text(kind: [u8; 4], data: &[u8]) -> Option<(&[u8], &[u8])> {
    let split = data.iter().position(|byte| *byte == 0)?;
    let key = &data[..split];
    if kind == *b"tEXt" {
        return Some((key, &data[split + 1..]));
    }
    if data.len() < split + 5 {
        return None;
    }
    let compression_flag = data[split + 1];
    if compression_flag != 0 {
        return None;
    }
    let language_start = split + 3;
    let language_end = data[language_start..].iter().position(|byte| *byte == 0)? + language_start;
    let translated_start = language_end + 1;
    let translated_end = data[translated_start..]
        .iter()
        .position(|byte| *byte == 0)?
        + translated_start;
    Some((key, &data[translated_end + 1..]))
}

fn is_iptc_key(key: &[u8]) -> bool {
    key.eq_ignore_ascii_case(IPTC_PNG_KEY) || key.eq_ignore_ascii_case(IPTC_RAW_PROFILE_KEY)
}

/// PNG carries IPTC as an ImageMagick "raw profile": an empty first line, the
/// profile name, the declared byte count, then wrapped hex. Some writers store
/// the IIM bytes verbatim instead, so that shape is accepted too.
fn decode_raw_profile(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.first() == Some(&0x1c) {
        return Some(bytes.to_vec());
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let _profile_name = lines.next()?;
    let declared = lines.next()?.parse::<usize>().ok()?;
    let mut output = Vec::with_capacity(declared);
    for line in lines {
        if !line.chars().all(|character| character.is_ascii_hexdigit()) || line.len() % 2 != 0 {
            return None;
        }
        for pair in line.as_bytes().chunks_exact(2) {
            output.push(u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?);
        }
    }
    (output.len() == declared).then_some(output)
}

fn encode_raw_profile(bytes: &[u8]) -> String {
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let lines = hex
        .as_bytes()
        .chunks(78)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    format!("\niptc\n{:8}\n{}\n", bytes.len(), lines)
}

fn write_png_iptc(bytes: &[u8], iptc: Option<&[u8]>) -> io::Result<Vec<u8>> {
    let chunks = png_chunks(bytes)?;
    let mut output = bytes[..8].to_vec();
    let text = iptc.map(encode_raw_profile);
    for chunk in chunks {
        if chunk.kind == *b"IEND" {
            if let Some(text) = text.as_ref() {
                let mut data = IPTC_RAW_PROFILE_KEY.to_vec();
                data.push(0);
                data.extend_from_slice(text.as_bytes());
                output.extend(png_chunk(*b"tEXt", &data));
            }
        } else if (chunk.kind == *b"tEXt" || chunk.kind == *b"iTXt")
            && png_metadata_text(chunk.kind, chunk.data).is_some_and(|value| is_iptc_key(value.0))
        {
            continue;
        }
        output.extend_from_slice(&bytes[chunk.start..chunk.end]);
    }
    Ok(output)
}

fn png_chunk(kind: [u8; 4], data: &[u8]) -> Vec<u8> {
    let mut crc = Hasher::new();
    crc.update(&kind);
    crc.update(data);
    let mut output = Vec::with_capacity(data.len() + 12);
    output.extend_from_slice(&(data.len() as u32).to_be_bytes());
    output.extend_from_slice(&kind);
    output.extend_from_slice(data);
    output.extend_from_slice(&crc.finalize().to_be_bytes());
    output
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".explorie-image-meta-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        crate::atomic_replace(&temporary, path)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn invalid_error(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn invalid_data<T>(message: String) -> io::Result<T> {
    Err(invalid_error(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(extension: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "explorie-image-metadata-test-{}.{}",
            Uuid::new_v4(),
            extension
        ))
    }

    fn metadata_value<'a>(fields: &'a [MetadataField], key: &str) -> &'a str {
        fields
            .iter()
            .find(|field| field.key == key)
            .map(|field| field.value.as_str())
            .unwrap_or_else(|| panic!("missing metadata field {key}"))
    }

    fn minimal_png() -> Vec<u8> {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend(png_chunk(
            *b"IHDR",
            &[0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0],
        ));
        png.extend(png_chunk(*b"IEND", &[]));
        png
    }

    fn minimal_tiff(include_resolution: bool) -> Vec<u8> {
        let mut entries: Vec<(u16, u16, u16, u32)> = vec![
            (0x0100, 4, 1, 1),
            (0x0101, 4, 1, 1),
            (0x0102, 3, 3, 176),
            (0x0103, 3, 1, 1),
            (0x0106, 3, 1, 2),
            (0x0111, 4, 1, 220),
            (0x0115, 3, 1, 3),
            (0x0116, 4, 1, 1),
            (0x0117, 4, 1, 3),
        ];
        if include_resolution {
            entries.extend([(0x011a, 5, 1, 182), (0x011b, 5, 1, 190), (0x0128, 3, 1, 2)]);
        }
        let mut tiff = vec![0; 223];
        tiff[..4].copy_from_slice(b"II*\0");
        tiff[4..8].copy_from_slice(&8u32.to_le_bytes());
        tiff[8..10].copy_from_slice(&(entries.len() as u16).to_le_bytes());
        for (index, (tag, format, count, value)) in entries.into_iter().enumerate() {
            let offset = 10 + index * 12;
            tiff[offset..offset + 2].copy_from_slice(&tag.to_le_bytes());
            tiff[offset + 2..offset + 4].copy_from_slice(&format.to_le_bytes());
            tiff[offset + 4..offset + 8].copy_from_slice(&(count as u32).to_le_bytes());
            if format == 3 && count == 1 {
                tiff[offset + 8..offset + 10].copy_from_slice(&(value as u16).to_le_bytes());
            } else {
                tiff[offset + 8..offset + 12].copy_from_slice(&value.to_le_bytes());
            }
        }
        tiff[176..182].copy_from_slice(&[8, 0, 8, 0, 8, 0]);
        tiff[182..190].copy_from_slice(&[72, 0, 0, 0, 1, 0, 0, 0]);
        tiff[190..198].copy_from_slice(&[72, 0, 0, 0, 1, 0, 0, 0]);
        tiff[220..223].copy_from_slice(&[0, 0, 0]);
        tiff
    }

    fn round_trip(extension: &str, bytes: Vec<u8>) {
        let path = test_path(extension);
        fs::write(&path, bytes).unwrap();
        let result = write(
            &path,
            &[
                MetadataUpdate {
                    key: "exif:GENERIC:010E".to_string(),
                    value: "Edited description".to_string(),
                },
                MetadataUpdate {
                    key: "iptc:2:105".to_string(),
                    value: "Edited headline".to_string(),
                },
            ],
        )
        .unwrap();
        assert_eq!(
            metadata_value(&result.exif, "exif:GENERIC:010E"),
            "Edited description"
        );
        assert_eq!(
            metadata_value(&result.iptc, "iptc:2:105"),
            "Edited headline"
        );

        let reread = read(&path).unwrap();
        assert_eq!(
            metadata_value(&reread.exif, "exif:GENERIC:010E"),
            "Edited description"
        );
        assert_eq!(
            metadata_value(&reread.iptc, "iptc:2:105"),
            "Edited headline"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn iptc_updates_are_editable_and_round_trip() {
        let mut block = Some(IimBlock::default());
        update_iptc(&mut block, "iptc:2:105", "Headline").unwrap();
        update_iptc(&mut block, "iptc:2:25", "one, two").unwrap();
        let fields = to_iptc_fields(block.as_ref().unwrap());
        assert_eq!(
            fields
                .iter()
                .find(|field| field.key == "iptc:2:105")
                .unwrap()
                .value,
            "Headline"
        );
        assert_eq!(
            fields
                .iter()
                .find(|field| field.key == "iptc:2:25")
                .unwrap()
                .value,
            "one, two"
        );
        assert!(has_iptc_content(block.as_ref().unwrap()));
    }

    #[test]
    fn png_iptc_chunk_round_trips() {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend(png_chunk(*b"IEND", &[]));
        let written = write_png_iptc(&png, Some(b"\x1c\x02\x69\x00\x04test")).unwrap();
        assert_eq!(
            extract_png_iptc(&written).unwrap(),
            Some(b"\x1c\x02\x69\x00\x04test".to_vec())
        );
    }

    #[test]
    fn jpeg_metadata_round_trips() {
        round_trip("jpg", vec![0xff, 0xd8, 0xff, 0xd9]);
    }

    #[test]
    fn png_metadata_round_trips() {
        round_trip("png", minimal_png());
    }

    #[test]
    fn tiff_metadata_round_trips() {
        round_trip("tiff", minimal_tiff(true));
    }

    #[test]
    fn tiff_metadata_writes_when_resolution_tags_are_missing() {
        let path = test_path("tiff");
        fs::write(&path, minimal_tiff(false)).unwrap();

        let result = write(
            &path,
            &[MetadataUpdate {
                key: "exif:GENERIC:010E".to_string(),
                value: "Edited description".to_string(),
            }],
        )
        .unwrap();

        assert_eq!(
            metadata_value(&result.exif, "exif:GENERIC:010E"),
            "Edited description"
        );
        assert_eq!(metadata_value(&result.exif, "exif:GENERIC:011A"), "72/1");
        assert_eq!(metadata_value(&result.exif, "exif:GENERIC:011B"), "72/1");
        assert_eq!(metadata_value(&result.exif, "exif:GENERIC:0128"), "2");

        let reread = read(&path).unwrap();
        assert_eq!(
            metadata_value(&reread.exif, "exif:GENERIC:010E"),
            "Edited description"
        );
        fs::remove_file(path).unwrap();
    }
}
