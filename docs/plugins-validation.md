# Integration validation — Windows x64, 2026-09-05

Local implementation evidence; this is not a release attestation. No release was published
and no installed application or user integration configuration was modified for these checks.

| Check | Evidence |
| --- | --- |
| Formatting | `cargo fmt --all -- --check` and `git diff --check` passed. |
| Strict lint | `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings` passed. |
| Workspace tests | `cargo test --locked --workspace --no-fail-fast -- --test-threads=1` passed: 410 tests, 7 explicitly ignored fixtures/benchmarks/platform checks. |
| Final provider change | Git and Obsidian tests passed after correcting vault URIs, including the additional vault-action regression test. |
| Native UI | Onboarding/settings defaults, overlapping badges and decorations, navigation/window isolation, native badge clicks, and List/Grid/Column layouts passed. |
| Runtime | Real executable fixtures exercised crashes, hangs, malformed/oversized output, status notifications, shared state and cleanup. Package tests covered integrity, compatibility, extraction paths, failed updates and developer provenance. |
| Syncthing | Local HTTP fixtures covered authentication/offline states and event reconciliation. Real localhost TLS handshakes verified the configured certificate and rejected a different certificate before sending the API key. |
| Packaging scripts | All 28 tests in `package-plugins.test.mjs`, `release-check.test.mjs` and `prepare-7zip.test.mjs` passed. |
| Windows packages | All three release executables were packaged and installed through the native manager's verified extraction/registry path, then executed against a folder containing all three integrations. |

Reproduce the real-package runtime check after `pnpm desktop:build`:

```powershell
$env:EXPLORIE_PLUGIN_SMOKE_CATALOG = Join-Path $PWD 'release-artifacts/plugins-x86_64-pc-windows-msvc/explorie-plugin-catalog-x86_64-pc-windows-msvc.json'
cargo test --locked -p explorie-native-services plugins::tests::official_packages_install_and_execute_through_native_manager -- --ignored --exact --nocapture
```

This test reads local release ZIP bytes instead of performing an HTTPS download; it uses
the production hash, manifest, extraction, atomic installation and executable process paths.
It does not establish that the unpublished GitHub URLs are available.

The release build embeds the corresponding catalog. The Windows installer is produced with
`scripts/package-gpui-windows.ps1` and that same `EXPLORIE_PLUGIN_CATALOG`, including catalog
verification and the bundled 7-Zip smoke check. Local artifacts are under
`release-artifacts/plugins-x86_64-pc-windows-msvc/` and `release-artifacts/windows/`.

Remaining release evidence:

- Exercise the actual HTTPS download and install/enable/update/uninstall flow in the packaged
  Windows app once the release assets are accessible. The local package test does not replace
  this check. Interactive installed-app testing was not performed in this session.
- Obtain equivalent macOS arm64 execution evidence for the signed/notarized packages and app.
  Windows compilation and macOS packaging-script tests do not establish macOS readiness.
- Run the existing signing, release smoke and publication gates against the final release
  candidate. Publication remains outside this implementation.

The GPUI suite was run serially because parallel native operation tests were timing-sensitive
under concurrent compiler load. The drag/drop fixture now minimizes its floating operation
panel before clicking a row that onboarding can otherwise position beneath that panel.
