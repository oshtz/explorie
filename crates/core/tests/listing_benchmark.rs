use explorie_core::list_dir;
use std::fs::File;
use std::time::Instant;

#[test]
#[ignore = "creates 100,000 files; run explicitly for listing benchmarks"]
fn lists_100k_files() {
    let directory = tempfile::tempdir().expect("create benchmark directory");
    for index in 0..100_000 {
        File::create(directory.path().join(format!("file-{index:06}.txt")))
            .expect("create benchmark file");
    }

    let started = Instant::now();
    let entries = list_dir(directory.path()).expect("list benchmark directory");
    let elapsed = started.elapsed();

    assert_eq!(entries.len(), 100_000);
    eprintln!("listed 100,000 files in {elapsed:.2?}");
}
