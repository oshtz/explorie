use explorie_core::{list_dir, update_custom_fields};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use tempfile::tempdir;

#[test]
fn list_dir_includes_custom_fields_from_metadata_file() {
    let temp_dir = tempdir().expect("temp dir");
    let root = temp_dir.path();

    fs::write(root.join("notes.txt"), b"notes").unwrap();
    let metadata = json!({
        "notes.txt": {
            "tag": "docs",
            "priority": 3
        },
        "other.txt": {
            "tag": "unused"
        }
    });
    fs::write(
        root.join(".explorie.json"),
        serde_json::to_string_pretty(&metadata).unwrap(),
    )
    .unwrap();

    let entries = list_dir(root).expect("list dir");
    assert_eq!(entries.len(), 1, "metadata file should not be listed");

    let entry = entries
        .iter()
        .find(|entry| entry.path.file_name().unwrap() == "notes.txt")
        .expect("notes.txt entry");
    assert_eq!(entry.custom.get("tag"), Some(&json!("docs")));
    assert_eq!(entry.custom.get("priority"), Some(&json!(3)));
}

#[test]
fn update_custom_fields_persists_metadata_and_listing() {
    let temp_dir = tempdir().expect("temp dir");
    let root = temp_dir.path();

    fs::write(root.join("clip.mov"), b"").unwrap();

    let mut custom_fields = HashMap::new();
    custom_fields.insert("label".to_string(), json!("video"));
    custom_fields.insert("rating".to_string(), json!(5));
    update_custom_fields(root, "clip.mov", custom_fields).unwrap();

    let metadata_path = root.join(".explorie.json");
    let metadata_text = fs::read_to_string(&metadata_path).unwrap();
    let metadata_json: serde_json::Value = serde_json::from_str(&metadata_text).unwrap();
    let saved = metadata_json
        .get("clip.mov")
        .and_then(|value| value.as_object())
        .expect("entry persisted");
    assert_eq!(saved.get("label"), Some(&json!("video")));
    assert_eq!(saved.get("rating"), Some(&json!(5)));

    let entries = list_dir(root).expect("list dir");
    let entry = entries
        .iter()
        .find(|entry| entry.path.file_name().unwrap() == "clip.mov")
        .expect("clip.mov entry");
    assert_eq!(entry.custom.get("label"), Some(&json!("video")));
    assert_eq!(entry.custom.get("rating"), Some(&json!(5)));
}
