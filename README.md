<p align="center">
  <img src="apps/desktop/native-assets/icons/icon.png" alt="explorie logo" width="128" height="128">
</p>

# explorie

**Pre-release, local-first file manager for Windows. macOS is a build target, not yet a verified release target.**
_MIT-licensed, built to be understandable, extensible, and easy to customize._

---

## Overview

explorie is a native GPUI file manager currently validated on **Windows**, with macOS support under active release validation. It uses plain JSON metadata and a themeable native UI. The Rust core owns directory listing, file operations, size calculation, archives, and `.explorie.json` custom fields; a Tauri-free service layer owns previews, jobs, recovery, remote drives, and OS integration.

Key traits:

- No paywalls, no telemetry.
- Hackable front to back: native theme tokens, `.explorie.json` metadata, and readable Rust crates.
- Fast-first: virtualization, cached folder sizes, and async previews.

Current features:

- **Multiple view modes:** List, Grid, and Finder-style Column views with a terminal preview column.
- **Tabbed browsing:** Open multiple directories in tabs (Ctrl/Cmd+T).
- **File previews:** One Explorie-owned Quick Look experience on Windows and macOS, including selected-set navigation and an index sheet, plus images, embedded audio/video, locally rendered PDFs, highlighted text/code, archive listings, and optional helper-generated previews.
- **Custom metadata:** Read/write `.explorie.json` for custom fields per folder.
- **Theming:** Dark/light/system themes, accent colors, local font stacks, UI scale, density, and more.
- **Drag & drop:** Move files between folders with visual feedback.
- **Settings panel:** Comprehensive appearance and behavior customization.
- **OS integration:** Native window controls and platform file opening.
- **Persistent Remote Drives:** Reconnect existing rclone remotes as native Windows drive letters or macOS volumes while explorie is running.

---

## Tech Stack

- **UI/Desktop:** Native GPUI pinned to an exact Zed revision with AccessKit semantics; Rust 2024 edition.
- **CLI:** Rust binary sharing the core crate, with listing and FFmpeg command-preview modes.
- **Libs:** `crates/core` (filesystem, metadata, archives, and file operations), `crates/native-services` (desktop jobs and OS integration), and `crates/ffmpeg-wrapper` (FFmpeg command builder).
- **Tests:** Rust unit/integration tests, GPUI-native rendered/input fixtures, and packaged-runtime smoke checks.

---

## System Requirements

### Required Dependencies

| Dependency  | Version               | Installation                                                           |
| ----------- | --------------------- | ---------------------------------------------------------------------- |
| **Node.js** | 20.x LTS              | [nodejs.org](https://nodejs.org) or `winget install OpenJS.NodeJS.LTS` |
| **pnpm**    | 9.x                   | `npm install -g pnpm` or `corepack enable`                             |
| **Rust**    | 1.98.0 (2024 edition) | [rustup.rs](https://rustup.rs)                                         |

### Optional Dependencies

| Dependency      | Purpose                                        | Installation                                                                           |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| **FFmpeg**      | Video thumbnails for non-browser video formats | Windows: `winget install ffmpeg`<br>macOS: `brew install ffmpeg`                       |
| **LibreOffice** | Office/OpenDocument preview conversion         | Windows: install from libreoffice.org<br>macOS: `brew install --cask libreoffice`      |
| **ImageMagick** | HEIC/TIFF/PSD preview conversion               | Windows: `winget install ImageMagick.ImageMagick`<br>macOS: `brew install imagemagick` |
| **cargo-watch** | Rust hot reload during dev                     | `cargo install cargo-watch`                                                            |

### Platform Notes

- **Windows:** Targets Windows 10/11 and has no WebView2 dependency. When Remote Drives first need WinFsp, Explorie offers the bundled official installer with a native administrator prompt.
- **macOS:** Builds target macOS 13+ and require Xcode Command Line Tools. Remote Drives use an administrator-approved, bundle-contained mount helper. Do not treat macOS as release-ready until the signed package passes the real-machine checklist below.

---

## Monorepo Layout

```
apps/
  desktop/
    gpui/                  # Native GPUI desktop application
    native-assets/         # Shared icons, sidecars, installers, licenses, macOS helpers
  cli/                     # CLI binary (Rust)
crates/
  core/                    # Rust business logic for listing, sizes, metadata
  native-services/         # Tauri-free jobs, previews, recovery, remote drives, OS integration
  ffmpeg-wrapper/          # FFmpeg command builder
sample/                    # Demo data + .explorie.json examples
```

---

## Install

Download the latest build from [GitHub Releases](https://github.com/oshtz/explorie/releases/latest):

- **Windows 10/11 x64:** Download `explorie-<version>-windows-x64-setup-unsigned.exe` and run the per-user installer. Windows may show an unsigned-app warning. After installation, Settings → System Integration can reversibly make Explorie the app Windows uses to open folders.
- **macOS 13+ on Apple silicon:** Download `explorie-<version>-macos-arm64.dmg`, open it, and move Explorie to Applications.

Platform-specific `SHA256SUMS` files are published alongside each release.

---

## Quickstart

```bash
git clone https://github.com/oshtz/explorie.git
cd explorie

pnpm install                             # install release-script tooling
pnpm desktop:dev                         # run the native GPUI desktop app

cargo run -p explorie-cli -- --help      # CLI help (listing and ffmpeg-preview)
```

---

## Commands & Scripts

### Development

| Command           | Description                                     |
| ----------------- | ----------------------------------------------- |
| `pnpm dev`        | Run the native GPUI desktop app                  |
| `pnpm dev:watch`  | Dev with Rust hot reload (requires cargo-watch) |
| `pnpm rust:watch` | Watch Rust crates and run tests on change       |

### Building & Testing

| Command              | Description                                                            |
| -------------------- | ---------------------------------------------------------------------- |
| `pnpm desktop:build` | Build the GPUI app for production                                      |
| `pnpm release:check` | Run local release-candidate checks and write `.release-checks` reports |
| `pnpm test`          | Run the complete authoritative Rust workspace                          |
| `pnpm test:rust`     | Run the complete authoritative Rust workspace                          |
| `pnpm lint`          | Check Rust formatting and strict workspace clippy                      |

For release-candidate verification, run `pnpm release:check` and use the release checklist below.

### CLI

```bash
cargo run -p explorie-cli -- --help
explorie [--with-sizes] [path]                           # List directory
explorie ffmpeg-preview in.mp4 out.webm --vf scale=1280:720  # Preview FFmpeg args
```

---

## Environment Variables

| Variable   | Default                    | Description               |
| ---------- | -------------------------- | ------------------------- |
| `RUST_LOG` | `info,explorie_core=debug` | Rust logging level filter |

---

## Screenshots

Add screenshots or a short demo GIF here before publishing the final public repository.

---

## Security and Filesystem Access

explorie is a local file manager. The GPUI process reads paths the user opens and delegates privileged or blocking work to typed native services. Write access is used only for explicit operations such as rename, move, copy, delete, archive, extract, metadata edits, and versioned app-local state.

Review the native-service path protections and packaged resources before shipping forks or release artifacts. Treat custom builds and helper binaries with the same care as any other local file-management tool. Do not paste sensitive file contents, private paths, credentials, or exploit details into public issues.

Security vulnerabilities should be reported through GitHub private vulnerability reporting for the release repository. If private reporting is unavailable, open a minimal public issue asking for a private contact route without including exploit details.

explorie does not include telemetry. Diagnostics exports are local-only and are designed to redact path-like and sensitive values, but review any report before sharing it.

Remote Drives use the bundled, pinned rclone executable with the user's existing rclone configuration. Choose **Remote Drives → Configure** to open rclone's own interactive setup in a terminal; when it closes, Explorie refreshes the remote list and opens the Add Drive dialog. Explorie never stores provider credentials or OAuth tokens. Encrypted rclone configurations must be unlockable non-interactively through the user's existing rclone environment or password command. Mount processes run only while explorie is open; stable per-profile VFS caches allow interrupted uploads to resume.

---

## Known Limitations

- Public binary releases still need real-machine packaged-app QA before broad distribution; macOS is explicitly not release-ready until that proof exists.
- Video previews use an optional local FFmpeg process for probing and bounded native playback; unavailable helpers produce an actionable fallback.
- Office/OpenDocument previews require LibreOffice. HEIC/HEIF/TIFF/PSD previews require ImageMagick.
- Explorie Quick Look and Column View behavior, plus notarized DMG behavior, should be checked on a real Mac for each release candidate.

---

## Release Checklist

Run:

```bash
cargo install cargo-audit --locked # once per machine
pnpm release:check
```

The command writes local evidence under `.release-checks/`, which is ignored by git. It requires a clean, version-aligned working tree; runs dependency audits, Rust formatting, the full workspace tests, strict clippy, and a locked GPUI release build; then verifies the executable under the workspace `target/release` directory.

Windows installer builds check the latest published GitHub Release automatically. Updates use the exact versioned unsigned Inno Setup asset and refuse to install unless its size and SHA-256 match `SHA256SUMS-windows.txt`; failed checks leave the installed app untouched. Windows Authenticode signing is intentionally not part of the release contract. Releases remain immutable and version-tag based. Bump the matching versions in the root package and GPUI Cargo manifest, merge the candidate commit to `main`, and wait for its `CI Gate` to pass before pushing a new `v<version>` tag. That immutable tag builds the candidate packages once and attaches them to a draft release. After those exact assets pass the real-machine checklist below, manually dispatch the release workflow from that tag with the Windows and macOS attestations and the two tested artifact SHA-256 values. The protected publish job verifies those hashes against the existing draft before publishing it without rebuilding. Existing releases, assets, and tags are never replaced; failures are fixed in a new version.

Protect `v*` tags against update/deletion, require `CI Gate` on `main`, protect the `release-signing` and `release-publish` environments, and enable immutable releases in the GitHub repository settings before public distribution.

macOS releases require these signing secrets:

- macOS: base64-encoded P12 in `APPLE_CERTIFICATE`, plus `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

The release workflow publishes an explicitly named unsigned per-user Windows x64 installer, a signed/notarized macOS arm64 DMG, and platform SHA-256 manifests. Windows packages intentionally remain unsigned, so SmartScreen or antivirus warnings are expected. CI installs, launch-smokes, and uninstalls the Windows package; publication additionally requires explicit proof that both candidates passed disposable filesystem operations on real machines.

Each `v<version>` draft contains `explorie-<version>-windows-x64-setup-unsigned.exe`, `explorie-<version>-macos-arm64.dmg`, `SHA256SUMS-windows.txt`, and `SHA256SUMS-macos.txt`.

Before creating a new tag, manually verify:

- Launch the generated app on the target OS.
- Open folders in List, Grid, and Column views.
- Preview text, image, PDF/document, video, archive, and unsupported files.
- Exercise copy, move, rename, delete/trash, undo/redo, archive, and extract flows on disposable files.
- Reopen the app and confirm persisted settings.
- Confirm Windows and macOS packaged-app behavior on real machines.
- Remove or uninstall v0.1.0 before first running v0.2.6; the permanent `com.omershatz.explorie` identity intentionally starts a clean application lineage.
- Install the Windows package, run `cargo test -p explorie-native-services integration::tests::windows_system_open_produces_a_real_shell_side_effect -- --exact --ignored` from an interactive Windows session, verify the System Integration toggle routes folder opens to Explorie and restores the prior handler when disabled or uninstalled, and confirm the unsigned warning is expected. Install the macOS package and verify signing/notarization plus both SHA-256 manifests.

Create a per-candidate real-machine evidence file with `pnpm platform:proof:init`, fill in the exact artifact names and SHA-256 hashes, then mark each observed check. `pnpm platform:proof:verify` rejects wrong artifact names, missing Windows multi-window/DnD/mixed-DPI/crash/folder-handler proof, and missing macOS multi-window/DnD/multi-monitor/crash/signing/notarization/Gatekeeper proof. It prints the two tested hashes to paste into the protected publication dispatch. The evidence stays under ignored `.release-checks/`; archive it alongside the candidate checksums before enabling the workflow attestations.

---

## Keyboard Shortcuts

| Shortcut     | Action                                               |
| ------------ | ---------------------------------------------------- |
| `Space`      | Open or close Quick Look for the selected file       |
| `Escape`     | Close dialogs, menus, Quick Look, or command palette |
| `Ctrl/Cmd+T` | New tab                                              |
| `Ctrl/Cmd+W` | Close tab                                            |
| `Ctrl/Cmd+P` | Command palette                                      |
| `Ctrl/Cmd+F` | Focus search                                         |
| `Ctrl/Cmd+,` | Settings                                             |
| `Arrow keys` | Navigate file views                                  |
| `Enter`      | Open selected item                                   |
| `F2`         | Rename selected item                                 |
| `Delete`     | Delete or trash selected item                        |

---

## Custom Metadata

explorie reads optional `.explorie.json` files from folders to attach custom fields to entries. A minimal file looks like:

```json
{
  "report.pdf": {
    "status": "review",
    "owner": "Alex",
    "tags": ["finance", "q2"]
  }
}
```

The metadata stays next to your files and is not synced by explorie itself.

---

## Third-Party Licenses and Attribution

explorie source code is MIT-licensed. The authoritative dependency graph is primarily MIT, Apache-2.0, Apache-2.0/MIT dual-licensed, BSD-2-Clause, BSD-3-Clause, ISC, MIT-0, and compatible permissive licenses.

Notable runtime and UI dependencies include GPUI, AccessKit, and Rust crates for filesystem, archive, tracing, local media decoding, and platform integration. Explorie bundles rclone v1.74.4 under its MIT license and includes the license in packaged applications. Windows packages also include the official, unmodified WinFsp installer: **WinFsp - Windows File System Proxy, Copyright (C) Bill Zissimopoulos**, [source and license](https://github.com/winfsp/winfsp). Optional external helpers such as FFmpeg, LibreOffice, and ImageMagick are not bundled; their own licenses apply to user-installed copies.

App icons and sample assets in this repository are project assets unless replaced before release.

Before publishing a binary distribution, regenerate dependency license evidence from the final release repository and artifact build:

```bash
pnpm licenses list
cargo metadata --format-version 1
```

---

## License

MIT

---

Contributions, forks, and experiments are welcome.
