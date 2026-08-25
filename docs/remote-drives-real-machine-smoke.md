# Remote Drives real-machine smoke

The Rust lifecycle harness is the credential-free CI gate:

```bash
pnpm test:rust
```

It uses the Rust test binary as a local fake rclone child and never reads a
developer's rclone configuration, contacts a provider, or requires WinFsp or
the macOS helper. The steps below are intentionally separate and must run only
on disposable real hardware with the packaged app.

## Windows and WinFsp

1. Use a disposable Windows 10/11 account or disposable test directory. Set
   up a temporary local-only rclone config; do not point the app at the normal
   config or add a cloud remote:

   ```powershell
   $smokeRoot = Join-Path $env:TEMP "explorie-remote-drive-smoke"
   New-Item -ItemType Directory -Force $smokeRoot | Out-Null
   @"
   [local]
   type = local
   "@ | Set-Content (Join-Path $smokeRoot "rclone.conf")
   New-Item -ItemType Directory -Force (Join-Path $smokeRoot "source") | Out-Null
   Set-Content (Join-Path $smokeRoot "source\sample.txt") "remote drive smoke"
   $env:RCLONE_CONFIG = Join-Path $smokeRoot "rclone.conf"
   Set-Location (Join-Path $smokeRoot "source")
   ```

2. Launch the packaged Windows app from that shell. In **Remote Drives**, use
   the bundled rclone and the `local` remote. If the environment reports
   WinFsp as missing, run the bundled installer through **Install WinFsp** and
   record the administrator approval and resulting service status.
3. Add a disposable drive letter (for example `R:`), connect it, and verify
   that the drive appears in Explorer and that the app reports `connected`.
   Copy `sample.txt` into the mounted drive, wait for the write to settle,
   then disconnect without force. If pending writes block disconnect, record
   the pending count and confirm that the exit blocker remains visible until
   the queue is clean; retry disconnect afterward.
4. Quit the app and verify that no rclone child belonging to the test profile
   remains. Remove the temporary directory and the test drive letter. Record
   the app version, Windows build, WinFsp version, drive letter, and pass/fail
   evidence in the release QA note.

## macOS helper

1. Use a disposable macOS 13+ machine and a temporary local-only config. Do
   not use the normal rclone config or a cloud provider:

   ```bash
   smoke_root="$(mktemp -d)"
   mkdir "$smoke_root/source"
   cat > "$smoke_root/rclone.conf" <<'EOF'
   [local]
   type = local
   EOF
   printf 'remote drive smoke\n' > "$smoke_root/source/sample.txt"
   export RCLONE_CONFIG="$smoke_root/rclone.conf"
   cd "$smoke_root/source"
   ```

2. Launch the signed packaged app from that shell. Register the bundled Remote
   Drives helper, approve it in macOS System Settings when prompted, and
   confirm that diagnostics changes from `approval-required` to `enabled`.
3. Add the `local` remote with a disposable volume name, connect it, and verify
   the volume appears under `/Volumes/<name>` and the app reports `connected`.
   Copy `sample.txt` into the volume, exercise normal disconnect and the
   pending-upload exit blocker, then retry once the queue is clean.
4. Quit the app, verify that the test rclone process and test volume are gone,
   unregister the helper if this is not a release machine, and remove the
   temporary directory. Record the app version, macOS version, helper approval
   state, volume name, and pass/fail evidence in the release QA note.

Never make WinFsp installation, helper approval, or provider credentials part
of the default CI job. This smoke is the real-machine proof for those native
boundaries; the Rust harness remains the deterministic lifecycle regression
gate.
