# macOS packaged-app QA — v0.2.7

Status: **blocked** — published DMG hash verified; signing, `pnpm release:check`, and the README real-machine checklist were not executed on physical Apple silicon.

This note does **not** make macOS a release target.

## Scope

- Asset under test: published [v0.2.7](https://github.com/oshtz/explorie/releases/tag/v0.2.7) `explorie-0.2.7-macos-arm64.dmg` plus `SHA256SUMS-macos.txt`.
- Constraint: real Apple silicon, not CI and not a VM. Releases stay immutable; Apple signing material stays in GitHub secrets.
- Uncovered surface vs CI: the signed/notarized DMG, Finder/Quick Look (`quick_look`, `get_finder_tags`, `set_finder_tags`, `get_finder_tag_colors`), and the mount helper (`src-tauri/macos/`, `macos_helper_status()`).

## Session

| Field | Value |
| --- | --- |
| Date | 2026-08-19 |
| Worker host | `DESKTOP-TC95RV6` Windows 11 x64 |
| Reachable Mac | Tailscale `psil-mbp-362` (`100.94.13.78`, macOS, online, TCP/22 open) |
| Mac session | none — OpenSSH `Permission denied (publickey,password,keyboard-interactive)` for `omershatz` and common aliases; Tailscale SSH not usable from this host |
| Worker pubkey | `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJA0wpMZsbENreFea9HGxn2YSbs7VfBQefL53TinSJii omershatzberg@gmail.com` |
| Tree | `wheeljack/task-723fa6d9f4aca1a42d39` @ `82322c1` |

## Results

| Item | Result | Evidence |
| --- | --- | --- |
| DMG SHA-256 matches `SHA256SUMS-macos.txt` | **pass** | Manifest `730dc7a15ebecd05f2feac559256134c11c542f1c681f10e5a98eaf1c5c6e375  explorie-0.2.7-macos-arm64.dmg`. Local SHA-256 of the downloaded 36,136,248-byte DMG is identical. GitHub asset digest matches. |
| Physical arm64 Mac confirmed (not VM) | blocked | Host is online on Tailscale; `uname -m` / `sysctl hw.model` not run. |
| `pnpm release:check` on that Mac writes `.release-checks/latest.json` with every gate passed | blocked | No Mac checkout session. A Windows run of the same script on this tree failed at `cargo audit` (unmaintained-crate warnings including `sevenz-rust` RUSTSEC-2026-0246); that is not Mac evidence. |
| Install from the release DMG | blocked | |
| `codesign --verify --deep --strict` on the installed app | blocked | |
| `spctl -a -vv` on the installed app | blocked | |
| List browsing | blocked | |
| Grid browsing | blocked | |
| Column browsing | blocked | |
| Text preview | blocked | |
| Image preview | blocked | |
| PDF / document preview | blocked | |
| Video preview | blocked | |
| Archive preview | blocked | |
| Unsupported preview | blocked | |
| Copy | blocked | |
| Move | blocked | |
| Rename | blocked | |
| Trash | blocked | |
| Undo / redo | blocked | |
| Compress | blocked | |
| Extract | blocked | |
| Settings persist after relaunch | blocked | |
| Quick Look (`qlmanage -p` via Space) | blocked | |
| Finder tags read / write / colors | blocked | |
| Remote drive connect (`/Volumes/<name>`, helper `enabled`) | blocked | |
| Remote drive disconnect | blocked | |

`blocked` means the item was not executed. It is not a product fail.

## Resume on `psil-mbp-362`

Authorize this worker first, then keep using disposable files only:

```bash
# hardware proof — refuse if not arm64 or if virtualized
uname -m
sysctl -n machdep.cpu.brand_string
sysctl -n hw.model
system_profiler SPHardwareDataType | sed -n '1,20p'

# hash
gh release download v0.2.7 --repo oshtz/explorie \
  --pattern 'explorie-0.2.7-macos-arm64.dmg' \
  --pattern 'SHA256SUMS-macos.txt'
shasum -a 256 -c SHA256SUMS-macos.txt

# install
hdiutil attach explorie-0.2.7-macos-arm64.dmg
cp -R /Volumes/Explorie/Explorie.app /Applications/
hdiutil detach /Volumes/Explorie

# signing / notarization
codesign --verify --deep --strict --verbose=2 /Applications/Explorie.app
spctl -a -vv /Applications/Explorie.app

# release gates on a clean, version-aligned checkout
git switch --detach v0.2.7
pnpm release:check
python3 - <<'PY'
import json
from pathlib import Path
report = json.loads(Path(".release-checks/latest.json").read_text())
assert report["status"] == "pass", report
print(report["status"], report["context"]["os"], report["context"]["arch"])
PY
```

Then record pass/fail here for every remaining row after exercising disposable files in the installed app: List/Grid/Column, text/image/PDF/video/archive/unsupported previews, copy/move/rename/trash/undo/redo/compress/extract, settings after relaunch, Space Quick Look, Finder tags, Remote Drives helper approval, connect (`/Volumes/<name>`), and disconnect.

Do not re-tag or replace v0.2.7 assets. Do not copy Apple signing secrets into the repo.
