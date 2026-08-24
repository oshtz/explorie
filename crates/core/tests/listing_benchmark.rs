use explorie_core::list_dir;
use std::fs::{self, File};
use std::path::Path;
use std::time::{Duration, Instant};

const TEN_K: usize = 10_000;
const HUNDRED_K: usize = 100_000;
const TEN_K_LISTING_LIMIT: Duration = Duration::from_secs(5);
const HUNDRED_K_LISTING_LIMIT: Duration = Duration::from_secs(10);

fn create_files(count: usize) -> tempfile::TempDir {
    let directory = tempfile::tempdir().expect("create benchmark directory");
    for index in 0..count {
        File::create(directory.path().join(format!("file-{index:06}.txt")))
            .expect("create benchmark file");
    }
    directory
}

fn measure_listing(path: &Path, expected_count: usize) -> Duration {
    let started = Instant::now();
    let entries = list_dir(path).expect("list benchmark directory");
    let list_elapsed = started.elapsed();

    let started = Instant::now();
    let enumerated = fs::read_dir(path)
        .expect("enumerate benchmark directory")
        .collect::<std::io::Result<Vec<_>>>()
        .expect("read benchmark directory entries");
    let read_dir_elapsed = started.elapsed();

    let started = Instant::now();
    let payload = serde_json::to_vec(&entries).expect("serialize benchmark entries");
    let serde_elapsed = started.elapsed();

    assert_eq!(enumerated.len(), expected_count);
    assert_eq!(entries.len(), expected_count);
    eprintln!(
        "{expected_count:>6} files: read_dir={read_dir_elapsed:.2?}, list_dir={list_elapsed:.2?}, serde_json={serde_elapsed:.2?} ({} bytes)",
        payload.len()
    );
    list_elapsed
}

#[test]
fn list_dir_10k_regression() {
    let directory = create_files(TEN_K);
    let elapsed = measure_listing(directory.path(), TEN_K);

    assert!(
        elapsed < TEN_K_LISTING_LIMIT,
        "list_dir for {TEN_K} entries took {elapsed:.2?}, exceeding the {TEN_K_LISTING_LIMIT:.2?} limit"
    );
}

#[test]
#[ignore = "creates 100,000 files; run explicitly for listing benchmarks"]
fn lists_100k_files() {
    let ten_k_directory = create_files(TEN_K);
    measure_listing(ten_k_directory.path(), TEN_K);

    let hundred_k_directory = create_files(HUNDRED_K);
    let elapsed = measure_listing(hundred_k_directory.path(), HUNDRED_K);

    assert!(
        elapsed < HUNDRED_K_LISTING_LIMIT,
        "list_dir for {HUNDRED_K} entries took {elapsed:.2?}, exceeding the {HUNDRED_K_LISTING_LIMIT:.2?} limit"
    );
}
