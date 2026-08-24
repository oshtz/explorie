use std::path::PathBuf;

use explorie_gpui::{
    APP_IDENTIFIER, APP_NAME, CoreDirectoryService, DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH,
    DirectoryWindow, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, acquire_single_instance,
    parse_startup_path,
};
use gpui::{App, AppContext, Application, Bounds, WindowBounds, WindowOptions, px, size};

#[cfg(any(windows, target_os = "macos"))]
fn main() {
    let Some(_instance) = acquire_single_instance().expect("unable to acquire app instance") else {
        return;
    };

    let path = parse_startup_path(std::env::args_os())
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));

    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(
            None,
            size(px(DEFAULT_WINDOW_WIDTH), px(DEFAULT_WINDOW_HEIGHT)),
            cx,
        );
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(MIN_WINDOW_WIDTH), px(MIN_WINDOW_HEIGHT))),
            is_resizable: true,
            app_id: Some(APP_IDENTIFIER.to_string()),
            ..Default::default()
        };
        let path = path.clone();
        cx.open_window(options, move |window, cx| {
            window.set_window_title(APP_NAME);
            cx.new(|cx| {
                let mut view = DirectoryWindow::new(path, CoreDirectoryService);
                view.start_listing(cx);
                view
            })
        })
        .expect("unable to open explorie window");
        cx.activate(true);
    });
}

#[cfg(not(any(windows, target_os = "macos")))]
fn main() {
    eprintln!("{APP_NAME} has no Linux product target");
}
