//! Parser and writer coverage over the committed fixture images in
//! `tests/fixtures/image_metadata` (see the README there for provenance).

use explorie_core::image_metadata::{ImageMetadata, MetadataUpdate, read, write};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/image_metadata")
        .join(name)
}

/// Copies a fixture into a scratch directory so writer tests never touch the
/// committed originals.
fn scratch(name: &str) -> (TempDir, PathBuf) {
    let directory = TempDir::new().unwrap();
    let target = directory.path().join(name);
    fs::copy(fixture(name), &target).unwrap();
    (directory, target)
}

fn value_of(fields: &[explorie_core::image_metadata::MetadataField], key: &str) -> String {
    fields
        .iter()
        .find(|field| field.key == key)
        .unwrap_or_else(|| panic!("missing metadata field {key}"))
        .value
        .clone()
}

fn assert_camera_and_timestamp(metadata: &ImageMetadata) {
    assert_eq!(value_of(&metadata.exif, "exif:GENERIC:010F"), "Explorie");
    assert_eq!(
        value_of(&metadata.exif, "exif:GENERIC:0110"),
        "Fixture Cam 1"
    );
    assert_eq!(
        value_of(&metadata.exif, "exif:EXIF:9003"),
        "2024:03:01 12:34:56"
    );
}

fn assert_fixture_iptc(metadata: &ImageMetadata) {
    assert_eq!(value_of(&metadata.iptc, "iptc:2:105"), "Fixture headline");
    assert_eq!(
        value_of(&metadata.iptc, "iptc:2:80"),
        "Fixture Photographer"
    );
    assert_eq!(value_of(&metadata.iptc, "iptc:2:25"), "alpha, beta");
}

#[test]
fn jpeg_fixture_exposes_camera_timestamp_dimensions_and_iptc() {
    let metadata = read(&fixture("camera.jpg")).unwrap();
    assert!(metadata.supported);
    assert_eq!(metadata.format, "JPEG");
    assert_eq!((metadata.width, metadata.height), (Some(6), Some(4)));
    assert_camera_and_timestamp(&metadata);
    assert_fixture_iptc(&metadata);
}

#[test]
fn png_fixture_exposes_camera_timestamp_dimensions_and_iptc() {
    let metadata = read(&fixture("camera.png")).unwrap();
    assert!(metadata.supported);
    assert_eq!(metadata.format, "PNG");
    assert_eq!((metadata.width, metadata.height), (Some(6), Some(4)));
    assert_camera_and_timestamp(&metadata);
    assert_fixture_iptc(&metadata);
}

#[test]
fn tiff_fixture_exposes_camera_timestamp_and_dimensions() {
    let metadata = read(&fixture("camera.tif")).unwrap();
    assert!(metadata.supported);
    assert_eq!(metadata.format, "TIFF");
    assert_eq!((metadata.width, metadata.height), (Some(6), Some(4)));
    assert_camera_and_timestamp(&metadata);
}

#[test]
fn a_file_without_metadata_reads_as_an_empty_panel_not_an_error() {
    let metadata = read(&fixture("bare.jpg")).unwrap();
    assert!(metadata.supported);
    assert_eq!((metadata.width, metadata.height), (Some(6), Some(4)));
    assert!(metadata.exif.is_empty());
    assert!(metadata.iptc.is_empty());
}

#[test]
fn an_unsupported_image_type_reads_as_an_empty_panel_not_an_error() {
    let metadata = read(&fixture("unsupported.gif")).unwrap();
    assert!(!metadata.supported);
    assert_eq!(metadata.format, "Unsupported");
    assert!(metadata.exif.is_empty());
    assert!(metadata.iptc.is_empty());
}

fn assert_edit_survives_reopen(name: &str, expect_iptc: bool) {
    let (_directory, path) = scratch(name);
    let original = fs::read(&path).unwrap();

    let mut updates = vec![MetadataUpdate {
        key: "exif:GENERIC:0110".to_string(),
        value: "Edited Cam 2".to_string(),
    }];
    if expect_iptc {
        updates.push(MetadataUpdate {
            key: "iptc:2:105".to_string(),
            value: "Edited headline".to_string(),
        });
    }

    let written = write(&path, &updates).unwrap();
    assert_eq!(value_of(&written.exif, "exif:GENERIC:0110"), "Edited Cam 2");

    // Re-reading from disk is the relaunch check: nothing is cached in process.
    let reread = read(&path).unwrap();
    assert_eq!(value_of(&reread.exif, "exif:GENERIC:0110"), "Edited Cam 2");
    assert_eq!(value_of(&reread.exif, "exif:GENERIC:010F"), "Explorie");
    assert_eq!((reread.width, reread.height), (Some(6), Some(4)));
    if expect_iptc {
        assert_eq!(value_of(&reread.iptc, "iptc:2:105"), "Edited headline");
        assert_eq!(value_of(&reread.iptc, "iptc:2:80"), "Fixture Photographer");
    }

    let updated = fs::read(&path).unwrap();
    assert!(
        updated.len() >= original.len() / 2,
        "{name} was truncated by the write"
    );
}

#[test]
fn jpeg_edits_survive_a_reopen() {
    assert_edit_survives_reopen("camera.jpg", true);
}

#[test]
fn png_edits_survive_a_reopen() {
    assert_edit_survives_reopen("camera.png", true);
}

#[test]
fn tiff_edits_survive_a_reopen() {
    assert_edit_survives_reopen("camera.tif", false);
}

#[test]
fn tiff_without_resolution_tags_can_be_edited_and_reopened() {
    let (_directory, path) = scratch("bare.tif");
    let written = write(
        &path,
        &[MetadataUpdate {
            key: "exif:GENERIC:0110".to_string(),
            value: "Scanner Cam".to_string(),
        }],
    )
    .unwrap();

    assert_eq!(value_of(&written.exif, "exif:GENERIC:0110"), "Scanner Cam");
    assert_eq!(value_of(&written.exif, "exif:GENERIC:011A"), "72/1");
    assert_eq!(value_of(&written.exif, "exif:GENERIC:011B"), "72/1");
    assert_eq!(value_of(&written.exif, "exif:GENERIC:0128"), "2");

    let reread = read(&path).unwrap();
    assert_eq!(value_of(&reread.exif, "exif:GENERIC:0110"), "Scanner Cam");
}

#[test]
fn metadata_can_be_added_to_a_file_that_had_none() {
    let (_directory, path) = scratch("bare.jpg");
    write(
        &path,
        &[
            MetadataUpdate {
                key: "exif:EXIF:9003".to_string(),
                value: "2025:12:24 08:00:00".to_string(),
            },
            MetadataUpdate {
                key: "iptc:2:105".to_string(),
                value: "Added headline".to_string(),
            },
        ],
    )
    .unwrap();

    let reread = read(&path).unwrap();
    assert_eq!(
        value_of(&reread.exif, "exif:EXIF:9003"),
        "2025:12:24 08:00:00"
    );
    assert_eq!(value_of(&reread.iptc, "iptc:2:105"), "Added headline");
}

#[test]
fn a_rejected_write_leaves_the_original_file_untouched() {
    let (_directory, path) = scratch("camera.jpg");
    let before = fs::read(&path).unwrap();

    // Image Width is a read-only field, so the whole update is refused.
    let error = write(
        &path,
        &[MetadataUpdate {
            key: "exif:GENERIC:0100".to_string(),
            value: "999".to_string(),
        }],
    )
    .unwrap_err();
    assert!(error.to_string().contains("read-only"), "{error}");

    assert_eq!(fs::read(&path).unwrap(), before);
    let leftovers = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(leftovers, 0, "a staged temporary file was left behind");
}

#[test]
fn writing_an_unsupported_type_is_refused_without_touching_the_file() {
    let (_directory, path) = scratch("unsupported.gif");
    let before = fs::read(&path).unwrap();
    let error = write(
        &path,
        &[MetadataUpdate {
            key: "exif:GENERIC:0110".to_string(),
            value: "Nope".to_string(),
        }],
    )
    .unwrap_err();
    assert!(error.to_string().contains("Unsupported"), "{error}");
    assert_eq!(fs::read(&path).unwrap(), before);
}
