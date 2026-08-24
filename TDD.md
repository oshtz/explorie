---
name: explorie-tdd
description: Technical design, contracts, risks and validation for the explorie file manager
kind: project-doc
---

# explorie Technical Design

This record captures the first native GPUI desktop foundation. The existing
Tauri + React target remains buildable during the migration and is not changed
by this foundation.

## 1. Compatibility Baseline

- Rust stable, edition 2024, workspace resolver 3, and the existing release profile remain the baseline.
- The validated product target is Windows 10/11 x64. macOS 13+ arm64 remains a build target whose packaged behavior requires real-machine validation. Linux remains outside the product scope.
- `explorie-core::list_dir_with_sizes(&Path, bool)` remains the listing contract. The GPUI target calls it directly and does not route through Tauri, a WebView, React, JavaScript, or an IPC bridge.
- The package identifier remains `com.omershatz.explorie`.

## 2. GPUI Selection

The dedicated `apps/desktop/gpui` crate pins `gpui = "=0.2.2"` from the crates.io registry. This version is recorded in `Cargo.lock` and is consumed with `default-features = false`, so Linux Wayland/X11 features are not part of the native product dependency graph. GPUI's Windows platform backend uses DirectX and its macOS backend uses AppKit/Metal; both are compatible with the existing Windows 10/11 and macOS 13+ targets.

The current worker verifies the Windows build. A macOS 13+ arm64 build and launch smoke remain a required release check because this host cannot produce physical Apple silicon evidence.

## 3. Crate Layout And Runtime Model

```text
apps/desktop/
  frontend/                 existing React + Tauri target, retained during cutover
    src-tauri/              existing native backend, unchanged by this foundation
  gpui/
    Cargo.toml              dedicated workspace member
    src/lib.rs              typed service boundary, task handoff, minimal view
    src/main.rs             native entry point, window contract, instance guard
```

`Application::new().run` owns the GPUI event loop and foreground executor. The
render callback only reads view state and builds native GPUI elements. Directory
enumeration is synchronous inside `explorie-core`, so `DirectoryWindow` submits
`list_directory_task` to GPUI's `BackgroundExecutor`. The result is applied on
the foreground context through a weak entity update; a closed window cannot be
resurrected by a late task. The task is retained by the view and is cancelled
when the view is dropped.

The first view intentionally renders a small, readable listing rather than
reimplementing the existing virtualized browsing surfaces. Virtualized List,
Grid, and Column views belong to the later native browsing task.

## 4. Typed Service And Event Boundary

`DirectoryService` is a native trait with a production `CoreDirectoryService`
implementation. It accepts `DirectoryListingRequest { path, calc_dir_size }`
and returns the existing `Vec<FileEntry>` core result. `DirectoryEvent` is the
typed UI boundary: `Listed { request, entries }` or `Failed { request, error }`.
`DirectoryServiceError` carries the failing path and a display-safe message.
No Tauri `AppHandle`, managed state, command name, or stringly typed frontend
bridge crosses this boundary.

The service/task test creates a temporary directory with a file and child
directory, submits the real `explorie-core::list_dir_with_sizes` call through
GPUI's test background executor, awaits the typed event, and asserts both
entries are present. This is the regression net for keeping blocking work off
the UI executor while the native service layer grows.

## 5. Window, Instance, Storage And UX Contracts

- The first window is native, decorated, resizable, centered, and starts at 1024x768.
- The minimum client size is 800x600. The values are explicit in `WindowOptions`, not only documentation.
- The package identifier is passed as GPUI's `app_id` and is also the stable identity used by the platform instance guard.
- Windows uses a named `Local\\com.omershatz.explorie` mutex. macOS uses an advisory lock under the temporary directory. A second process exits without opening a second window. Argument forwarding/focus of an already-running process remains an unresolved migration item; the Tauri single-instance callback remains authoritative until that handoff is implemented.
- Versioned app configuration belongs in the platform app-data directory: `%APPDATA%\\explorie\\config-v1.json` on Windows and `~/Library/Application Support/explorie/config-v1.json` on macOS. It stores preferences, window geometry, tabs, workspaces, and helper approvals, never credentials or tokens. Writes will be atomic and malformed files will be preserved for recovery.
- Crash-session state belongs beside configuration as `crash-session-v1.json`, containing only the last recoverable navigation/session record and a clean-shutdown marker. It is cleared after a clean launch and retained for a recovery prompt after an abnormal exit. This foundation does not silently migrate or erase the old browser-backed values.
- GPUI focus handles and keyboard actions are the accessibility foundation. Every native control will have a stable element id, keyboard path, visible focus state, and text label; later views will add semantic roles as GPUI exposes them. The first view has no animation. Future motion is opt-in, interruptible, and disabled when reduced motion is selected or the platform requests it.

## 6. Native Preview And Packaging Strategy

The GPUI preview service will keep bounded reads and source-identity cache
keys in the native service layer:

- Images use local `image` decoding and GPUI image elements; EXIF/IPTC parsing stays local and GPS remains collapsed until explicit reveal.
- Audio uses platform media APIs (Media Foundation on Windows and AVFoundation on macOS) through a native player view; no HTML media element or WebView is retained.
- Video uses Media Foundation/AVFoundation for supported codecs and the existing optional FFmpeg helper for still artifacts when a codec is unsupported. FFmpeg remains optional and never auto-downloads.
- PDF uses PDFKit on macOS and a separately packaged, sandboxed native PDF rasterization adapter on Windows. A missing adapter is an explicit recoverable preview state, not a WebView fallback.
- Text and code use bounded native file reads and GPUI text layout/highlighting. Archive, Office, and other generated previews remain service-owned and report named optional-helper failures.

Packaging stays platform-specific and local-only:

- Windows preserves `com.omershatz.explorie`, stages the pinned rclone sidecar from `scripts/prepare-rclone.mjs`, ships the official WinFsp MSI only as the existing user-approved installer resource, and includes `rclone-COPYING` plus `winfsp-NOTICE.txt`.
- macOS stages the platform rclone sidecar under the app resources and bundles the existing `explorie-mountd` helper plus `com.omershatz.explorie.mountd.plist`. The helper and app are signed/notarized with the existing release identity and minimum macOS 13.0 setting.
- Linux packaging is intentionally not defined.

## 7. Unresolved Risks

- GPUI 0.2.2 does not publish a stable MSRV in its package metadata. Stable Rust 1.92 builds this target, but the project should pin and document the first verified MSRV before release.
- The Windows target is verified by the development build; macOS 13+ arm64 still needs a physical build and launch smoke.
- The initial mutex/lock guard prevents duplicate processes but does not yet forward a second invocation's directory to the existing window like the Tauri plugin does.
- GPUI's current public surface does not provide the same mature semantic accessibility tree as the browser UI. Native focus and keyboard behavior are established first; semantic-role coverage must be validated before the React target is removed.
- Native audio/video/PDF adapters, config migration, crash recovery UI, helper approval UI, and resource packaging are recorded strategies, not claimed as implemented by this foundation.
- GPU driver initialization and packaged resource extraction need Windows portable and signed macOS package smoke tests. No network, accounts, telemetry, or provider credentials are introduced.
