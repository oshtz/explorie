---
name: explorie-listing-performance
description: Measured directory-listing performance and regression contract
kind: project-doc
---

# Directory-listing performance record

## Scope and decision

`list_dir` remains a source-compatible single `Vec<FileEntry>` return. The
measured path is below the 5 second/10 second targets, so streaming and
pagination are deferred. `list_dir_with_sizes(path, calc_dir_size)` keeps
directory-size work opt-in: `list_dir` and the `list_files` Tauri command pass
`false`; the recursive `walkdir` path is used only when the flag is `true`.

The implementation changes are deliberately local: listing workers reuse the
`DirEntry` path for metadata, link, xattr, optional size and UUID work, and an
empty custom-field map skips the per-entry lookup. The public functions and
the Tauri command payload are unchanged.

The default traversal is one shallow `fs::read_dir` collection followed by
Rayon entry construction. `walkdir` belongs to the recursive `dir_size` and
`dir_info` paths, not to the default listing; this is why the benchmark keeps
`calc_dir_size` false.

## Windows validated target-machine measurements

Run on 2026-08-12 on Windows 11 Pro 10.0.26200, Intel Core Ultra 9 285K, 24
logical processors, debug profile. The required command was:

```text
cargo test -p explorie-core --test listing_benchmark -- --ignored --nocapture
```

The observed run printed:

| Entries | `read_dir` probe | `list_dir` / `FileEntry` construction | `serde_json` serialization | Payload bytes |
| ------: | ---------------: | ------------------------------------: | -------------------------: | ------------: |
|  10,000 |          8.34 ms |                             128.17 ms |                   64.04 ms |     3,039,208 |
| 100,000 |         79.53 ms |                                1.33 s |                  662.18 ms |    30,389,194 |

The `read_dir` probe is a post-list control and is not additive to
`list_dir`. It establishes that shallow enumeration is small compared with
per-entry metadata/link/xattr checks, stable UUID creation and `FileEntry`
assembly. JSON serialization is material but does not make the whole-array
return a target violation. The 100,000-entry assertion remains `#[ignore]` so
default CI does not create 100,000 files.

The desktop command boundary was measured separately on 2026-08-12 on the
same machine with the ignored `list_files_ipc_100k_benchmark` test:

```text
cargo test -p explorie-desktop --bin explorie-desktop list_files_ipc_100k_benchmark -- --ignored --nocapture
```

That test dispatches the real `list_files` command through Tauri's IPC test
responder, including the `InvokeResponse` JSON serialization, then measures
deserialization of the returned payload (the JS-side parse analogue). The
Tauri mock does not claim to measure WebView2's native transport itself.

| Entries | `list_files` command + response serialization | Response deserialization | Payload bytes |
| ------: | --------------------------------------------: | ------------------------: | ------------: |
|  10,000 |                                      193.49 ms |                 36.33 ms |     3,238,635 |
| 100,000 |                                         1.91 s |                374.02 ms |    32,389,271 |

The command path remains below the 5 second/10 second targets. The extra
response parse cost is visible but still does not justify changing the
source-compatible single-vector contract.

## Browser handoff measurements

The opt-in `node scripts/listing-ui-benchmark.mjs` harness runs the real Vite
React build in headless Chromium. It uses the existing development fixture,
expands it to 100,000 entries for the large case, exercises both list and grid
views, loads the actual transformed `workers/sortWorker.ts`, and reports JSON
stringify/parse, structured-clone, worker postMessage/sort, and visible-item
timings. It measures the browser-side handoff path; the
separate desktop test above covers the actual Tauri command and response
serialization, while native WebView2 transport remains platform-dependent.
Because the harness runs the web-only Vite build, it uses `App.tsx`'s
development fixture and does not invoke `list_files`; its handoff numbers are
therefore a browser proxy rather than an end-to-end IPC claim.

Observed on the same machine (Vite dev build, Chromium headless):

| Entries | View | Visible DOM items | Worker boundary | Worker + React update |
| ------: | ---- | ----------------: | --------------: | --------------------: |
|  10,000 | list |           21 rows |        68.6 ms |              110.6 ms |
|  10,000 | grid |          42 items |        48.1 ms |               86.8 ms |
| 100,000 | list |           21 rows |       190.5 ms |              271.8 ms |
| 100,000 | grid |          42 items |       206.6 ms |              285.8 ms |

The same harness measured the 100,000-entry browser boundary/worker sample at
25,277,781 JSON bytes, 43.1 ms stringify, 46.9 ms parse, 111.3 ms
`structuredClone`, and 236.2 ms for worker `postMessage` plus the actual sort
worker. The view rows now wait for the real sort-worker message and two
animation frames before recording the React result; this covers the grid path
even though GridView has no sorting spinner. The UI keeps the DOM bounded
through `useVirtualRows` and `useVirtualGrid`; sorting still receives the
complete array only at the existing 5,000-entry threshold. Together with the
Rust timings, these measurements do not show the single-shot vector boundary
as the bottleneck, so no streaming or pagination is justified.

## Regression contract

`crates/core/tests/listing_benchmark.rs` contains a non-ignored 10,000-entry
test that fails when `list_dir` exceeds 5 seconds. The ignored 100,000-entry
benchmark asserts the 10-second target and prints the phase timings above.
`.github/workflows/ci.yml` runs the non-ignored benchmark target in the Windows
Rust job, and `pnpm test:rust` therefore carries the guard without running the
100,000-entry setup. The latency target and guard are intentionally scoped to
the validated Windows target machine; the macOS job runs the core library and
metadata tests plus the Tauri build, but excludes the listing benchmark and
does not claim or enforce an unmeasured macOS latency baseline.

The desktop command-boundary benchmark is also `#[ignore]`; it is an explicit
diagnostic run and is not part of default CI.

This record is for the available Windows target machine. A physical macOS
baseline still requires a macOS target machine; no macOS timing is inferred
from the Windows result. The README currently treats macOS as a build target
under release validation rather than a verified release target, so this record
does not present a fabricated macOS baseline. If macOS becomes a validated
latency target, add comparable 10,000- and 100,000-entry measurements and
restore a macOS-specific regression guard in CI.
