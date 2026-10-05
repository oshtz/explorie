//! Behaviors found by testing the signed macOS build against Finder: the
//! operations history around conflict prompts, modal prompts drawn above the
//! operations panel, search, and the smaller Finder conventions.

use super::tests::{fixture_dir, kept_name, remove_fixture};
use super::*;
use explorie_native_services::ResourcePaths;
use gpui::{Modifiers, TestAppContext, VisualTestContext};
use std::fs;

/// Run the executor until `done` holds, letting native jobs finish on their
/// own threads.
fn wait_until(
    view: &Entity<DirectoryWindow>,
    cx: &mut VisualTestContext,
    what: &str,
    mut done: impl FnMut(&DirectoryWindow) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        cx.run_until_parked();
        if view.update(cx, |view, _| done(view)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// A destination folder already holding `report.txt`, and a source folder
/// with a newer `report.txt` to copy into it.
struct ConflictFixture {
    root: PathBuf,
    source: PathBuf,
    destination: PathBuf,
}

impl ConflictFixture {
    fn new() -> Self {
        let root = fixture_dir();
        let source_dir = root.join("source");
        let destination = root.join("destination");
        fs::create_dir(&source_dir).unwrap();
        fs::create_dir(&destination).unwrap();
        let source = source_dir.join("report.txt");
        fs::write(&source, "new").unwrap();
        fs::write(destination.join("report.txt"), "existing").unwrap();
        Self {
            root,
            source,
            destination,
        }
    }

    /// A window on the destination that started copying the source into
    /// it and is now asking what to do about the conflict.
    fn open_at_conflict<'a>(
        &self,
        cx: &'a mut TestAppContext,
    ) -> (Entity<DirectoryWindow>, &'a mut VisualTestContext) {
        let services = NativeServices::new(ResourcePaths::test(&self.root));
        let destination = self.destination.clone();
        let (view, window) =
            cx.add_window_view(|_, cx| DirectoryWindow::new(destination, services, cx));
        window.simulate_resize(gpui::size(px(800.0), px(600.0)));
        view.update(window, |view, cx| {
            view.start_service_events(cx);
            view.start_file_operation(
                FileOperationRequest {
                    kind: FileOperationKind::Copy,
                    sources: vec![self.source.clone()],
                    destination: Some(self.destination.clone()),
                    conflict_policy: ConflictPolicy::Error,
                },
                cx,
            );
        });
        wait_until(&view, window, "the conflict prompt", |view| {
            !view.operation_ui.conflict_prompts.is_empty()
        });
        (view, window)
    }
}

#[gpui::test]
fn a_pending_conflict_waits_for_a_decision_instead_of_failing(cx: &mut TestAppContext) {
    let fixture = ConflictFixture::new();
    let (view, window) = fixture.open_at_conflict(cx);

    view.update(window, |view, _| {
        let operations = view.operations.operations();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].status(), OperationStatus::NeedsDecision);
        assert_eq!(operations[0].error(), None);
        // The prompt is how the conflict is resolved, not Retry.
        assert_eq!(view.operations.latest_retryable_id(), None);
        assert_eq!(
            view.status_message.as_deref(),
            Some("A destination conflict needs your decision")
        );
    });
    window.run_until_parked();
    assert!(
        window.debug_bounds("operation-decision-0").is_some(),
        "the history row explains it is waiting for a decision"
    );

    let keep_both = window.debug_bounds("conflict-keep-both").unwrap().center();
    window.simulate_click(keep_both, Modifiers::default());
    let kept = fixture.destination.join(kept_name("report.txt"));
    wait_until(&view, window, "the kept copy", |view| {
        kept.is_file() && view.operations.active_count() == 0
    });

    assert_eq!(fs::read_to_string(&kept).unwrap(), "new");
    assert_eq!(
        fs::read_to_string(fixture.destination.join("report.txt")).unwrap(),
        "existing"
    );
    view.update(window, |view, _| {
        // One entry, now showing the outcome of the decision.
        let operations = view.operations.operations();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].status(), OperationStatus::Completed);
        assert_eq!(operations[0].total_items(), 1);
        assert_eq!(operations[0].error(), None);
        assert!(view.operation_ui.conflict_prompts.is_empty());
    });
    window.run_until_parked();
    assert!(window.debug_bounds("operation-decision-0").is_none());
    remove_fixture(&fixture.root);
}

#[gpui::test]
fn skipping_the_only_conflict_records_a_skipped_operation(cx: &mut TestAppContext) {
    let fixture = ConflictFixture::new();
    let (view, window) = fixture.open_at_conflict(cx);

    let skip = window.debug_bounds("conflict-skip").unwrap().center();
    window.simulate_click(skip, Modifiers::default());
    window.run_until_parked();

    view.update(window, |view, _| {
        let operations = view.operations.operations();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].status(), OperationStatus::Skipped);
        assert_eq!(operations[0].skipped_items(), 1);
        assert_eq!(operations[0].retryable_count(), 0);
        assert!(view.operation_ui.conflict_prompts.is_empty());
    });
    assert!(!fixture.destination.join(kept_name("report.txt")).exists());
    remove_fixture(&fixture.root);
}

#[gpui::test]
fn cancel_all_records_the_waiting_operation_as_cancelled(cx: &mut TestAppContext) {
    let fixture = ConflictFixture::new();
    let (view, window) = fixture.open_at_conflict(cx);

    view.update(window, |view, cx| view.cancel_all_file_conflicts(cx));
    window.run_until_parked();

    view.update(window, |view, _| {
        let operations = view.operations.operations();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].status(), OperationStatus::Cancelled);
        assert_eq!(operations[0].error(), None);
    });
    remove_fixture(&fixture.root);
}
