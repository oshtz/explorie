use explorie_core::{
    CustomFieldType, create_explorie_schema, get_custom_fields_schema, list_dir,
    update_custom_fields, update_custom_fields_batch,
};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::sync::{Arc, Barrier};
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

#[test]
fn malformed_metadata_is_reported_and_never_overwritten() {
    let temp_dir = tempdir().expect("temp dir");
    let root = temp_dir.path();
    let metadata_path = root.join(".explorie.json");
    fs::write(root.join("notes.txt"), b"notes").unwrap();
    fs::write(&metadata_path, b"{ definitely not valid json").unwrap();

    assert_eq!(
        list_dir(root).unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
    let mut fields = HashMap::new();
    fields.insert("tag".to_string(), json!("docs"));
    assert_eq!(
        update_custom_fields(root, "notes.txt", fields)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::InvalidData
    );
    assert_eq!(
        fs::read_to_string(metadata_path).unwrap(),
        "{ definitely not valid json"
    );
}

#[test]
fn concurrent_metadata_updates_preserve_every_entry() {
    let temp_dir = tempdir().expect("temp dir");
    let root = Arc::new(temp_dir.path().to_path_buf());
    let barrier = Arc::new(Barrier::new(3));
    let mut threads = Vec::new();

    for name in ["one.txt", "two.txt"] {
        let root = Arc::clone(&root);
        let barrier = Arc::clone(&barrier);
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            let mut fields = HashMap::new();
            fields.insert("name".to_string(), json!(name));
            update_custom_fields(&root, name, fields).unwrap();
        }));
    }
    barrier.wait();
    for thread in threads {
        thread.join().unwrap();
    }

    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(".explorie.json")).unwrap()).unwrap();
    assert_eq!(metadata["one.txt"]["name"], json!("one.txt"));
    assert_eq!(metadata["two.txt"]["name"], json!("two.txt"));
}

#[test]
fn schema_replacement_invalidates_the_listing_cache() {
    let temp_dir = tempdir().expect("temp dir");
    let root = temp_dir.path();
    fs::write(root.join("notes.txt"), b"notes").unwrap();

    let mut first = HashMap::new();
    first.insert(
        "notes.txt".to_string(),
        HashMap::from([("status".to_string(), json!("first"))]),
    );
    create_explorie_schema(root, first).unwrap();
    assert_eq!(list_dir(root).unwrap()[0].custom["status"], json!("first"));

    let mut second = HashMap::new();
    second.insert(
        "notes.txt".to_string(),
        HashMap::from([("status".to_string(), json!("second"))]),
    );
    create_explorie_schema(root, second).unwrap();
    assert_eq!(list_dir(root).unwrap()[0].custom["status"], json!("second"));
}

#[test]
fn legacy_schema_filename_is_not_reinterpreted_as_a_declaration() {
    let temp_dir = tempdir().expect("temp dir");
    let root = temp_dir.path();
    fs::write(root.join("schema"), b"legacy").unwrap();
    fs::write(
        root.join(".explorie.json"),
        serde_json::to_string(&json!({
            "schema": {
                "fields": "legacy",
                "tags": ["legacy", "metadata"]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let entry = list_dir(root)
        .unwrap()
        .into_iter()
        .find(|entry| entry.path.ends_with("schema"))
        .expect("schema file entry");
    assert_eq!(entry.custom["tags"], json!(["legacy", "metadata"]));
    assert_eq!(entry.custom["fields"], json!("legacy"));
    assert!(get_custom_fields_schema(root).unwrap().is_none());
}

#[test]
fn legacy_schema_alias_entries_with_declaration_shaped_values_are_preserved() {
    let temp_dir = tempdir().expect("temp dir");
    let root = temp_dir.path();
    for file_name in ["__schema", "_schema", "schema"] {
        fs::write(root.join(file_name), b"legacy").unwrap();
    }
    fs::write(
        root.join(".explorie.json"),
        serde_json::to_string(&json!({
            "__schema": {
                "fields": { "legacy": "ordinary metadata" },
                "required": ["legacy"]
            },
            "_schema": {
                "fields": { "legacy": { "nested": true } },
                "required": ["legacy"]
            },
            "schema": {
                "fields": { "legacy": ["old", "values"] },
                "required": ["legacy"]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let entries = list_dir(root).unwrap();
    for file_name in ["__schema", "_schema", "schema"] {
        let entry = entries
            .iter()
            .find(|entry| entry.path.ends_with(file_name))
            .expect("legacy schema alias file entry");
        assert!(entry.custom.contains_key("fields"));
        assert!(entry.custom.contains_key("required"));
    }
    assert!(get_custom_fields_schema(root).unwrap().is_none());
}

#[test]
fn typed_schema_accepts_date_url_and_enum_values() {
    let temp_dir = tempdir().expect("temp dir");
    let root = temp_dir.path();
    fs::write(root.join("event.txt"), b"event").unwrap();

    let schema = HashMap::from([
        (
            "$schema".to_string(),
            serde_json::from_value(json!({
                "fields": {
                    "when": { "type": "date", "required": true },
                    "website": { "type": "url" },
                    "state": { "type": "enum", "values": ["draft", "published"] }
                }
            }))
            .unwrap(),
        ),
        (
            "event.txt".to_string(),
            HashMap::from([
                ("when".to_string(), json!("2026-08-09")),
                ("website".to_string(), json!("https://example.com/events")),
                ("state".to_string(), json!("draft")),
            ]),
        ),
    ]);

    create_explorie_schema(root, schema).unwrap();
    let declaration = get_custom_fields_schema(root).unwrap().unwrap();
    assert_eq!(
        declaration.fields["website"].field_type,
        CustomFieldType::Url
    );
    let entry = list_dir(root)
        .unwrap()
        .into_iter()
        .find(|entry| entry.path.ends_with("event.txt"))
        .unwrap();
    assert_eq!(entry.custom["when"], json!("2026-08-09"));
    assert_eq!(entry.custom["website"], json!("https://example.com/events"));
    assert_eq!(entry.custom["state"], json!("draft"));
}

#[test]
fn typed_schema_rejects_invalid_date_url_and_enum_without_writing() {
    let temp_dir = tempdir().expect("temp dir");
    let root = temp_dir.path();
    fs::write(root.join("event.txt"), b"event").unwrap();

    let schema = HashMap::from([
        (
            "$schema".to_string(),
            serde_json::from_value(json!({
                "fields": {
                    "when": { "type": "date", "required": true },
                    "website": { "type": "url" },
                    "state": { "type": "enum", "values": ["draft", "published"] }
                }
            }))
            .unwrap(),
        ),
        (
            "event.txt".to_string(),
            HashMap::from([
                ("when".to_string(), json!("2026-08-09")),
                ("website".to_string(), json!("https://example.com/events")),
                ("state".to_string(), json!("draft")),
            ]),
        ),
    ]);
    create_explorie_schema(root, schema).unwrap();
    let original = fs::read_to_string(root.join(".explorie.json")).unwrap();

    let missing_required = update_custom_fields(
        root,
        "event.txt",
        HashMap::from([
            ("website".to_string(), json!("https://example.com/events")),
            ("state".to_string(), json!("draft")),
        ]),
    )
    .expect_err("missing required value should be rejected");
    assert!(missing_required.to_string().contains("is required"));
    assert_eq!(
        fs::read_to_string(root.join(".explorie.json")).unwrap(),
        original
    );

    for (field, value, expected_reason) in [
        ("when", json!("2026-02-30"), "expected date"),
        ("when", json!("0000-01-01"), "expected date"),
        ("website", json!("not a url"), "expected url"),
        ("website", json!("https://example.com:bad"), "expected url"),
        ("state", json!("archived"), "expected enum"),
    ] {
        let mut fields = HashMap::from([
            ("when".to_string(), json!("2026-08-09")),
            ("website".to_string(), json!("https://example.com/events")),
            ("state".to_string(), json!("draft")),
        ]);
        fields.insert(field.to_string(), value);
        let result = update_custom_fields(root, "event.txt", fields);
        let error = result.expect_err("invalid typed value should be rejected");
        assert!(error.to_string().contains(expected_reason));
        assert_eq!(
            fs::read_to_string(root.join(".explorie.json")).unwrap(),
            original
        );
    }
}

#[test]
fn batch_metadata_update_validates_every_entry_before_one_write() {
    let temp_dir = tempdir().expect("temp dir");
    let root = temp_dir.path();
    fs::write(root.join("one.txt"), b"one").unwrap();
    fs::write(root.join("two.txt"), b"two").unwrap();

    let initial = HashMap::from([
        (
            "$schema".to_string(),
            serde_json::from_value(json!({
                "fields": { "state": { "type": "enum", "values": ["todo", "done"] } }
            }))
            .unwrap(),
        ),
        (
            "one.txt".to_string(),
            HashMap::from([("state".to_string(), json!("todo"))]),
        ),
        (
            "two.txt".to_string(),
            HashMap::from([("state".to_string(), json!("todo"))]),
        ),
    ]);
    create_explorie_schema(root, initial).unwrap();

    let invalid_batch = HashMap::from([
        (
            "one.txt".to_string(),
            HashMap::from([("state".to_string(), json!("done"))]),
        ),
        (
            "two.txt".to_string(),
            HashMap::from([("state".to_string(), json!("invalid"))]),
        ),
    ]);
    assert!(update_custom_fields_batch(root, invalid_batch).is_err());
    let entries = list_dir(root).unwrap();
    assert_eq!(
        entries
            .iter()
            .find(|entry| entry.path.ends_with("one.txt"))
            .unwrap()
            .custom["state"],
        json!("todo")
    );
    assert_eq!(
        entries
            .iter()
            .find(|entry| entry.path.ends_with("two.txt"))
            .unwrap()
            .custom["state"],
        json!("todo")
    );

    let valid_batch = HashMap::from([
        (
            "one.txt".to_string(),
            HashMap::from([("state".to_string(), json!("done"))]),
        ),
        (
            "two.txt".to_string(),
            HashMap::from([("state".to_string(), json!("done"))]),
        ),
    ]);
    update_custom_fields_batch(root, valid_batch).unwrap();
    let entries = list_dir(root).unwrap();
    assert!(
        entries
            .iter()
            .all(|entry| entry.custom["state"] == json!("done"))
    );
}

#[cfg(unix)]
#[test]
fn listings_and_directory_info_do_not_follow_symlinks() {
    use std::os::unix::fs::symlink;

    let temp_dir = tempdir().expect("temp dir");
    let root = temp_dir.path();
    let data = root.join("data");
    fs::create_dir(&data).unwrap();
    fs::write(data.join("file.txt"), b"abc").unwrap();
    symlink(root, data.join("loop")).unwrap();
    symlink(root.join("missing"), root.join("dangling")).unwrap();

    let entries = list_dir(root).unwrap();
    let dangling = entries
        .iter()
        .find(|entry| entry.path.ends_with("dangling"))
        .unwrap();
    assert!(dangling.is_symlink);
    assert!(!dangling.is_dir);

    let (count, size) = explorie_core::dir_info(root).unwrap();
    assert_eq!(count, 4);
    assert_eq!(size, 3);
}
