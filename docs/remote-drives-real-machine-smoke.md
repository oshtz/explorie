# Remote Drives real-machine smoke

Default CI does not run these steps. CI uses a fake rclone child and does not require WinFsp or macOS helper approval.

Use a disposable rclone config. Do not point Explorie at cloud credentials or the user rclone configuration.

```bash
export RCLONE_CONFIG="$PWD/.explorie-smoke-rclone.conf"
rclone config create explorie-smoke local
```

On Windows, set `RCLONE_CONFIG` in the same session before launching Explorie.

## Windows (WinFsp)

1. Launch a local Explorie build on a machine without an active remote-drive mount.
2. Open Remote Drives. If WinFsp is missing, install it from the in-app bundled installer and confirm the launcher service is running.
3. Configure or select a disposable remote from the throwaway `RCLONE_CONFIG` above (local backend is enough).
4. Connect to an unused drive letter. Confirm the letter appears in Explorer and in Explorie.
5. Copy a small file onto the mount, wait until pending uploads drop to zero, then Disconnect.
6. Confirm the drive letter is gone and no `rclone.exe` child remains in Task Manager.
7. Quit Explorie with a pending upload still in flight and confirm the exit blocker asks before tearing down.

## macOS (privileged helper)

1. Launch a local Explorie build on Apple silicon or Intel macOS 13+.
2. Register the Remote Drives helper and approve it in System Settings.
3. Connect a disposable remote as a volume under `/Volumes`. Confirm Finder shows it.
4. Disconnect. Confirm the volume is unmounted and the rclone/NFS child is gone.
5. Unregister the helper. Confirm Remote Drives reports that approval is required again.

Record pass/fail for WinFsp install, helper approval, connect, pending-upload blocker, disconnect, and process teardown. This note is not a CI gate.
