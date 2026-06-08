<p align="center">
  <img src="apps/desktop/frontend/public/icon.png" alt="explorie logo" width="128" height="128">
</p>

# explorie

**Fast, local-first file manager for Windows and macOS.**
_MIT-licensed, built to be understandable, extensible, and easy to customize._

---

## Overview

explorie is a Tauri + React file manager for **Windows and macOS** with plain JSON metadata, themeable UI, and a "do what you want" philosophy. The Rust core exposes directory listing, size calculation, and `.explorie.json` custom fields. A minimal plugin host and FFmpeg command builder are included for experimentation (both wired into the CLI and exposed as Tauri commands).

Key traits:

- No paywalls, no telemetry.
- Hackable front to back: CSS variables, `.explorie.json` metadata, Rust/TS helper crates.
- Fast-first: virtualization, cached folder sizes, and async previews.

Current features:

- **Multiple view modes:** List, Grid, and Finder-style Column views.
- **Tabbed browsing:** Open multiple directories in tabs (Ctrl/Cmd+T).
- **File previews:** Images, browser-playable videos, PDFs, code files with syntax highlighting, archive listings, and optional helper-generated previews.
- **Custom metadata:** Read/write `.explorie.json` for custom fields per folder.
- **Theming:** Dark/light/system themes, accent colors, custom fonts (including Google Fonts import), UI scale, density, and more.
- **Drag & drop:** Move files between folders with visual feedback.
- **Settings panel:** Comprehensive appearance and behavior customization.
- **OS integration:** Option to set as default file manager (Windows), native window controls.

---

## Tech Stack

- **UI:** React 19, Vite 6, PNPM 9, Zustand 5, @tanstack/react-virtual, highlight.js (code previews), pixelarticons.
- **Desktop:** Tauri 2.2 (Rust 2024 edition), with plugins for FS access and window controls.
- **CLI:** Rust binary sharing the core crate; extra subcommands for plugin calling and FFmpeg command previews.
- **Libs:** `crates/core` (fs + metadata), `crates/plugin-host` (in-memory registry), `crates/ffmpeg-wrapper` (FFmpeg command builder), `packages/sdk` (TS helpers).
- **Tests:** `cargo test`, Playwright e2e.

---

## System Requirements

### Required Dependencies

| Dependency  | Version               | Installation                                                           |
| ----------- | --------------------- | ---------------------------------------------------------------------- |
| **Node.js** | 20.x LTS              | [nodejs.org](https://nodejs.org) or `winget install OpenJS.NodeJS.LTS` |
| **pnpm**    | 9.x                   | `npm install -g pnpm` or `corepack enable`                             |
| **Rust**    | stable (2024 edition) | [rustup.rs](https://rustup.rs)                                         |

### Optional Dependencies

| Dependency      | Purpose                                        | Installation                                                                           |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| **FFmpeg**      | Video thumbnails for non-browser video formats | Windows: `winget install ffmpeg`<br>macOS: `brew install ffmpeg`                       |
| **LibreOffice** | Office/OpenDocument preview conversion         | Windows: install from libreoffice.org<br>macOS: `brew install --cask libreoffice`      |
| **ImageMagick** | HEIC/TIFF/PSD preview conversion               | Windows: `winget install ImageMagick.ImageMagick`<br>macOS: `brew install imagemagick` |
| **cargo-watch** | Rust hot reload during dev                     | `cargo install cargo-watch`                                                            |

### Platform Notes

- **Windows:** Targets Windows 10/11. WebView2 runtime (usually pre-installed).
- **macOS:** Targets macOS 11+ (Big Sur). Xcode Command Line Tools required.

---

## Monorepo Layout

```
apps/
  desktop/                 # Tauri runner (Rust backend in src-tauri/, React frontend in frontend/)
    frontend/
      src/
        components/        # React components (ListView, GridView, ColumnView, Preview, etc.)
        hooks/             # Custom React hooks (useDirSize, useDragStart, useVirtualRows, etc.)
        utils/             # Utilities (fs, date, highlight, customColumns)
        workers/           # Web workers (sortWorker)
      src-tauri/           # Tauri Rust backend with file system commands
  cli/                     # CLI binary (Rust)
crates/
  core/                    # Rust business logic for listing, sizes, metadata
  plugin-host/             # Minimal plugin registry/dispatcher
  ffmpeg-wrapper/          # FFmpeg command builder
packages/
  sdk/                     # TypeScript SDK helpers + types
  themes/                  # Example theme(s) (e.g., dracula.css)
tests/                     # Playwright specs
sample/                    # Demo data + .explorie.json examples
```

---

## Quickstart

```bash
git clone https://github.com/oshtz/explorie.git
cd explorie

pnpm install                             # install frontend deps
pnpm desktop:dev                         # run Tauri dev (frontend + Rust)
# or: pnpm desktop:web                   # web-only Vite dev

cargo run -p explorie-cli -- --help      # CLI help (listing, plugin-call, ffmpeg-preview)
```

---

## Commands & Scripts

### Development

| Command            | Description                                     |
| ------------------ | ----------------------------------------------- |
| `pnpm dev`         | Run Tauri dev (frontend + Rust)                 |
| `pnpm dev:watch`   | Dev with Rust hot reload (requires cargo-watch) |
| `pnpm desktop:web` | Web-only Vite dev server                        |
| `pnpm rust:watch`  | Watch Rust crates and run tests on change       |

### Building & Testing

| Command              | Description                                                            |
| -------------------- | ---------------------------------------------------------------------- |
| `pnpm desktop:build` | Build Tauri app for production                                         |
| `pnpm release:check` | Run local release-candidate checks and write `.release-checks` reports |
| `pnpm test`          | Run all tests (Rust + Playwright)                                      |
| `pnpm test:rust`     | Run Rust tests only                                                    |
| `pnpm test:unit`     | Run frontend unit tests (Vitest)                                       |
| `pnpm lint`          | Check formatting (cargo fmt + clippy)                                  |
| `pnpm typecheck`     | TypeScript type checking                                               |

For release-candidate verification, run `pnpm release:check` and use the release checklist below.

### CLI

```bash
cargo run -p explorie-cli -- --help
explorie [--with-sizes] [path]                           # List directory
explorie plugin-call info summary '{"path": "."}'        # Call plugin
explorie ffmpeg-preview in.mp4 out.webm --vf scale=1280:720  # Preview FFmpeg args
```

PowerShell-friendly JSON payload:

```powershell
$payload = '{\"path\":\".\"}'
cargo run -p explorie-cli -- plugin-call info summary $payload
```

`cmd.exe` inline JSON payload:

```bat
cargo run -p explorie-cli -- plugin-call info summary {\"path\":\".\"}
```

---

## Environment Variables

Copy `.env.example` to `.env.local` for local overrides. See `apps/desktop/frontend/.env.example` for frontend-specific variables.

| Variable            | Default                    | Description                                     |
| ------------------- | -------------------------- | ----------------------------------------------- |
| `RUST_LOG`          | `info,explorie_core=debug` | Rust logging level filter                       |
| `VITE_DEV_PORT`     | `5173`                     | Vite dev server port                            |
| `VITE_SOURCEMAP`    | `false`                    | Enable source maps in production                |
| `VITE_DROP_CONSOLE` | `true`                     | Strip console.log in production                 |
| `ANALYZE`           | `0`                        | Enable bundle analyzer (`ANALYZE=1 pnpm build`) |

---

## Screenshots

Add screenshots or a short demo GIF here before publishing the final public repository.

---

## Security and Filesystem Access

explorie is a local file manager. To browse and preview files, the desktop app requests broad read access to common user folders, mounted volumes, and Windows drive roots through Tauri's filesystem and asset protocols. Write access is intended for explicit file operations that the user initiates, such as rename, move, copy, delete, archive, extract, and metadata edits.

Review `apps/desktop/frontend/src-tauri/tauri.conf.json` before shipping forks or release artifacts. Treat plugins, custom builds, and helper binaries with the same care as any other local file-management tool. Do not paste sensitive file contents, private paths, credentials, or exploit details into public issues.

Security vulnerabilities should be reported through GitHub private vulnerability reporting for the release repository. If private reporting is unavailable, open a minimal public issue asking for a private contact route without including exploit details.

explorie does not include telemetry. Diagnostics exports are local-only and are designed to redact path-like and sensitive values, but review any report before sharing it.

---

## Known Limitations

- Public binary releases still need real-machine packaged-app QA on Windows and macOS before broad distribution.
- MP4, WebM, and M4V previews use the platform WebView video stack. Codec support depends on the OS/WebView; H.264/AAC MP4 is the expected happy path.
- MOV, AVI, MKV, WMV, FLV, M2TS, MPEG/MPG, and 3GP previews use FFmpeg to generate a still thumbnail when FFmpeg is installed.
- Office/OpenDocument previews require LibreOffice. HEIC/HEIF/TIFF/PSD previews require ImageMagick.
- macOS Finder/Quick Look integration, notarized DMG behavior, and Windows default-file-manager registration should be checked on real machines for each release candidate.
- The plugin host is intentionally minimal. Treat experimental plugins as trusted local code.

---

## Release Checklist

Run:

```bash
pnpm release:check
```

The command writes local evidence under `.release-checks/`, which is ignored by git. Check `.release-checks/latest.md` before publishing. It runs TypeScript, ESLint, Prettier, Rust fmt/tests/clippy, frontend unit tests, Playwright E2E on an isolated local Vite port, frontend build, Tauri no-bundle build, and whitespace checks.

Before publishing binaries, also manually verify:

- Launch the generated app on the target OS.
- Open folders in List, Grid, and Column views.
- Preview text, image, PDF/document, video, archive, and unsupported files.
- Exercise copy, move, rename, delete/trash, undo/redo, archive, and extract flows on disposable files.
- Reopen the app and confirm persisted settings.
- Confirm Windows default-file-manager and macOS packaged-app behavior on real machines if those features are part of the release.

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

explorie source code is MIT-licensed. The current dependency graph is primarily MIT, Apache-2.0, Apache-2.0/MIT dual-licensed, BSD-2-Clause, BSD-3-Clause, ISC, MIT-0, and compatible permissive licenses. Current frontend tooling scans also show `caniuse-lite` under CC-BY-4.0, `argparse` under Python-2.0, and `type-fest` under MIT or CC0-1.0.

Notable runtime and UI dependencies include React, Vite, Tauri, Zustand, TanStack Virtual, highlight.js, Pixelarticons, and Rust crates for filesystem, archive, tracing, Tauri, and platform integration. Optional external helpers such as FFmpeg, LibreOffice, and ImageMagick are not bundled by this repository; their own licenses apply to user-installed copies.

The sample Dracula theme is provided as a small CSS example. App icons and sample assets in this repository are project assets unless replaced before release.

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
