use std::path::PathBuf;

use explorie_gpui::{
    APP_IDENTIFIER, APP_NAME, DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH, DirectoryWindow,
    ExplorieAssets, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, RecoveryMarker, acquire_single_instance,
    parse_startup_path,
};
use explorie_native_services::{NativeServices, ResourcePaths};
use gpui::{
    App, AppContext, Bounds, Focusable, TitlebarOptions, WindowBounds, WindowOptions, px, size,
};
#[cfg(not(target_os = "windows"))]
use gpui_platform::application;

#[cfg(target_os = "windows")]
fn application() -> gpui::Application {
    gpui::Application::with_platform(std::rc::Rc::new(
        gpui_windows::WindowsPlatform::new(false)
            .expect("failed to initialize the Windows GPUI platform"),
    ))
}

#[cfg(any(windows, target_os = "macos"))]
fn main() {
    let explicit_path = parse_startup_path(std::env::args_os());
    let startup_path_is_explicit = explicit_path.is_some();
    let services = native_services();
    let Some(instance) =
        acquire_single_instance(&services.resources().config_dir, explicit_path.as_deref())
            .expect("unable to acquire or contact app instance")
    else {
        return;
    };
    let _instance = instance.guard;
    let single_instance_requests = instance.requests;
    let path = explicit_path
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let recovery_marker = RecoveryMarker::begin(&services.resources().config_dir)
        .map_err(|error| eprintln!("native recovery tracking unavailable: {error}"))
        .ok();
    let previous_session_unclean = recovery_marker
        .as_ref()
        .is_some_and(RecoveryMarker::previous_session_unclean);

    application()
        .with_assets(ExplorieAssets)
        .run(move |cx: &mut App| {
            let shutdown_remotes = services.remotes.clone();
            let shutdown_audio = services.audio.clone();
            let shutdown_video = services.video.clone();
            cx.on_app_quit(move |_| {
                shutdown_audio.stop();
                shutdown_video.stop();
                async {}
            })
            .detach();
            cx.on_app_quit(move |_| {
                let task = shutdown_remotes.disconnect_all();
                async move {
                    if let Err(error) = task.await {
                        eprintln!("unable to stop remote drives during shutdown: {error}");
                    }
                }
            })
            .detach();
            if let Some(marker) = recovery_marker.clone() {
                cx.on_app_quit(move |_| {
                    let marker = marker.clone();
                    async move {
                        if let Err(error) = marker.clear() {
                            eprintln!("unable to clear native recovery marker: {error}");
                        }
                    }
                })
                .detach();
            }
            let bounds = Bounds::centered(
                None,
                size(px(DEFAULT_WINDOW_WIDTH), px(DEFAULT_WINDOW_HEIGHT)),
                cx,
            );
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(MIN_WINDOW_WIDTH), px(MIN_WINDOW_HEIGHT))),
                titlebar: Some(TitlebarOptions {
                    title: Some(APP_NAME.into()),
                    appears_transparent: cfg!(target_os = "windows"),
                    traffic_light_position: None,
                }),
                is_resizable: true,
                app_id: Some(APP_IDENTIFIER.to_string()),
                ..Default::default()
            };
            let path = path.clone();
            let services = services.clone();
            cx.open_window(options, move |window, cx| {
                window.set_window_title(APP_NAME);
                let view = cx.new(|cx| {
                    let mut view =
                        DirectoryWindow::restore(path, startup_path_is_explicit, services, cx);
                    view.install_shortcut_bindings(cx);
                    view.start_listing(cx);
                    view.start_watching(cx);
                    view.start_system_locations(cx);
                    view.start_service_events(cx);
                    view.start_preview_helpers(cx);
                    view.start_remote_drives(cx);
                    if previous_session_unclean {
                        view.announce_unclean_recovery(cx);
                    }
                    view
                });
                view.update(cx, |view, cx| {
                    view.start_single_instance_requests(single_instance_requests, window, cx);
                });
                let close_view = view.clone();
                window.on_window_should_close(cx, move |_, cx| {
                    close_view.update(cx, |view, cx| view.request_window_close(cx))
                });
                window.focus(&view.focus_handle(cx), cx);
                view
            })
            .expect("unable to open explorie window");
            cx.activate(true);
        });
}

#[cfg(any(windows, target_os = "macos"))]
fn native_services() -> NativeServices {
    let resources = ResourcePaths::default().with_app_version(env!("CARGO_PKG_VERSION"));
    let resources = std::env::var_os("EXPLORIE_TEST_CONFIG_DIR")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .map_or(resources.clone(), |path| {
            resources
                .with_config_dir(&path)
                .with_cache_dir(path.join("cache"))
        });
    NativeServices::new(resources)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn main() {
    eprintln!("{APP_NAME} has no Linux product target");
}
