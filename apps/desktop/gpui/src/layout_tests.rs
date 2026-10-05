//! Layout checks at the default 1024×768 window, where the sidebar and the
//! preview inspector leave the content the least room.

use gpui::TestAppContext;
use uuid::Uuid;

use super::*;

fn entry_at(path: PathBuf, is_dir: bool) -> FileEntry {
    FileEntry {
        id: Uuid::new_v4(),
        path,
        size: 1_234,
        modified: std::time::SystemTime::UNIX_EPOCH,
        hidden: false,
        is_dir,
        custom: std::collections::HashMap::new(),
        is_symlink: false,
        is_junction: false,
        link_target: None,
        has_xattrs: false,
        is_package: false,
        link_target_is_dir: false,
        is_cloud_placeholder: false,
        tags: Vec::new(),
    }
}

#[gpui::test]
fn column_strip_scrolls_the_leaf_into_view_without_clipping_the_leftmost_column(
    cx: &mut TestAppContext,
) {
    let leaf = (1..=7).fold(PathBuf::from("column-align"), |path, depth| {
        path.join(format!("level-{depth}"))
    });
    let stack = build_path_stack(&leaf);
    let (view, window) = cx.add_window_view(|window, cx| {
        let mut view = DirectoryWindow::new(leaf.clone(), NativeServices::default(), cx);
        view.visuals.icon_loading_enabled = false;
        view.browser.set_view_mode(ViewMode::Column);
        view.settings.view.show_preview_panel = true;
        view.column_view.columns = ColumnState::new(&leaf);
        for (index, path) in stack.iter().enumerate() {
            let mut entries = (0..10)
                .map(|item| entry_at(path.join(format!("folder-{item}")), true))
                .collect::<Vec<_>>();
            if let Some(child) = stack.get(index + 1) {
                entries.push(entry_at(child.clone(), true));
            }
            assert!(view.column_view.columns.apply_listed(path, entries));
            // Narrow enough that the leaf, its parent and the preview fit
            // whole in the strip, but a third column does not.
            view.browser.set_column_view_width(path.clone(), 200);
        }
        view.column_view.scroll_handles = stack
            .iter()
            .map(|_| UniformListScrollHandle::new())
            .collect();
        view.column_view.scroll_to_leaf_attempts = 3;
        view.listing.state = ListingState::Ready;
        window.focus(&view.focus_handle, cx);
        view
    });
    window.simulate_resize(gpui::size(px(1_024.0), px(768.0)));
    window.run_until_parked();
    // Reveal the leaf the way navigating there does, now that the window has
    // its final size.
    view.update(window, |view, cx| {
        view.column_view.scroll_to_leaf_attempts = 3;
        cx.notify();
    });
    window.run_until_parked();

    let strip = view.update(window, |view, _| view.column_view.strip_scroll.clone());
    let strip_bounds = strip.bounds();
    assert!(
        strip.offset().x < px(0.0),
        "the strip must scroll to the leaf"
    );
    let columns = (0..stack.len())
        .map(|index| {
            window
                .debug_bounds(Box::leak(format!("column-{index}").into_boxed_str()))
                .unwrap()
        })
        .collect::<Vec<_>>();
    let visible = columns
        .iter()
        .enumerate()
        .filter(|(_, bounds)| bounds.right() > strip_bounds.left() + px(0.5))
        .collect::<Vec<_>>();
    let (first_index, first) = visible[0];
    assert!(
        (f32::from(first.left()) - f32::from(strip_bounds.left())).abs() < 0.5,
        "leftmost visible column {first_index} {first:?} is clipped by strip {strip_bounds:?}"
    );
    assert_eq!(
        first_index,
        stack.len() - 2,
        "the parent column must be shown whole when there is room for it"
    );
    let leaf_bounds = columns.last().unwrap();
    assert!(leaf_bounds.right() <= strip_bounds.right() + px(0.5));
    let preview = window.debug_bounds("column-preview").unwrap();
    assert!(
        (f32::from(preview.right()) - f32::from(strip_bounds.right())).abs() < 0.5,
        "the preview {preview:?} must reach the strip's end {strip_bounds:?}"
    );
}
