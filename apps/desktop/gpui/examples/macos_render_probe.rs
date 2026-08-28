#[cfg(target_os = "macos")]
use std::{error::Error, path::PathBuf, sync::Arc};

#[cfg(target_os = "macos")]
use explorie_gpui::{ExplorieAssets, MACOS_SYSTEM_FONT_FAMILY};
#[cfg(target_os = "macos")]
use gpui::{
    AppContext, Context, HeadlessAppContext, Render, Window, div, prelude::*, px, rgb, size,
};
#[cfg(target_os = "macos")]
struct RenderProbe;

#[cfg(target_os = "macos")]
impl Render for RenderProbe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .size_full()
            .items_center()
            .justify_center()
            .bg(rgb(0x101010))
            .font_family(MACOS_SYSTEM_FONT_FAMILY)
            .text_size(px(24.0))
            .text_color(rgb(0xffffff))
            .child("Explorie macOS text probe")
    }
}

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn Error>> {
    let platform = gpui_platform::current_platform(true);
    let mut cx = HeadlessAppContext::with_platform(
        platform.text_system(),
        Arc::new(ExplorieAssets),
        gpui_platform::current_headless_renderer,
    );
    let window = cx.open_window(size(px(640.0), px(120.0)), |_, cx| cx.new(|_| RenderProbe))?;
    cx.run_until_parked();
    let image = cx.capture_screenshot(window.into())?;
    let visible_text_pixels = image
        .pixels()
        .filter(|pixel| pixel[0] > 80 && pixel[1] > 80 && pixel[2] > 80 && pixel[3] > 0)
        .count();
    let dark_background_pixels = image
        .pixels()
        .filter(|pixel| pixel[0] < 40 && pixel[1] < 40 && pixel[2] < 40 && pixel[3] > 0)
        .count();
    let total_pixels = image.width() as usize * image.height() as usize;

    let output = std::env::var_os("EXPLORIE_RENDER_PROBE_OUTPUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/macos-render-probe.png"));
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    image.save(&output)?;

    if dark_background_pixels < total_pixels * 3 / 4 {
        return Err(format!(
            "macOS Metal probe did not render the expected dark surface ({dark_background_pixels}/{total_pixels} pixels)"
        )
        .into());
    }
    if visible_text_pixels < 100 {
        return Err(format!(
            "macOS Metal probe rendered only {visible_text_pixels} visible text pixels"
        )
        .into());
    }
    println!(
        "macOS Metal text probe passed with {visible_text_pixels} visible pixels: {}",
        output.display()
    );
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {}
