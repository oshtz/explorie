use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, UNIX_EPOCH};

use explorie_core::FileEntry;
use serde_json::{Value, json};
use uuid::Uuid;

const FILE_ENTRY_FIXTURE: &str = include_str!("fixtures/file_entry.json");

fn fixture_entry() -> FileEntry {
    FileEntry {
        id: Uuid::parse_str("4f8f2c3a-36c8-4f3f-9db9-0d59db2aa001").unwrap(),
        path: PathBuf::from("/fixtures/report.txt"),
        size: 4096,
        modified: UNIX_EPOCH + Duration::new(1_700_000_000, 123_456_700),
        hidden: false,
        is_dir: false,
        custom: HashMap::from([
            ("rating".to_string(), json!(5)),
            ("tag".to_string(), json!("fixture")),
        ]),
        is_symlink: true,
        is_junction: false,
        link_target: Some("/fixtures/source.txt".to_string()),
        has_xattrs: true,
    }
}

#[test]
fn file_entry_fixture_matches_serde_contract() {
    let fixture: Value = serde_json::from_str(FILE_ENTRY_FIXTURE).unwrap();
    let serialized = serde_json::to_value(fixture_entry()).unwrap();
    assert_eq!(serialized, fixture);

    let deserialized: FileEntry = serde_json::from_str(FILE_ENTRY_FIXTURE).unwrap();
    assert_eq!(serde_json::to_value(deserialized).unwrap(), fixture);
}
