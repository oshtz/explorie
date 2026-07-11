import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Icon } from './Icon';
import {
  loadRemoteDrives,
  saveRemoteDrives,
  type DisconnectResult,
  type RemoteDriveEnvironment,
  type RemoteDriveExitBlocker,
  type RemoteDriveProfile,
  type RemoteDriveStatus,
} from '../utils/remoteDrives';
import styles from './RemoteDrivesSection.module.css';

const WINDOWS_LETTERS = Array.from({ length: 23 }, (_, index) =>
  String.fromCharCode('D'.charCodeAt(0) + index)
);

const disconnected = (id: string): RemoteDriveStatus => ({ id, state: 'disconnected' });

export function RemoteDrivesSection({
  onSelectLocation,
}: {
  onSelectLocation: (path: string) => void;
}) {
  const [profiles, setProfiles] = useState(loadRemoteDrives);
  const [statuses, setStatuses] = useState<Record<string, RemoteDriveStatus>>({});
  const [environment, setEnvironment] = useState<RemoteDriveEnvironment | null>(null);
  const [remotes, setRemotes] = useState<string[]>([]);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [installingWinFsp, setInstallingWinFsp] = useState(false);
  const [configuringRemotes, setConfiguringRemotes] = useState(false);
  const [editing, setEditing] = useState<RemoteDriveProfile | null>(null);
  const autoStarted = useRef(false);

  const updateStatus = useCallback((status: RemoteDriveStatus) => {
    setStatuses((current) => ({ ...current, [status.id]: status }));
  }, []);

  const refreshEnvironment = useCallback(async () => {
    try {
      const next = await invoke<RemoteDriveEnvironment>('get_remote_drive_environment');
      setEnvironment(next);
      setSetupError(next.error ?? null);
      if (next.rcloneAvailable) {
        setRemotes(await invoke<string[]>('list_rclone_remotes'));
      }
    } catch (error) {
      setSetupError(String(error));
    }
  }, []);

  const connect = useCallback(
    async (profile: RemoteDriveProfile) => {
      updateStatus({ id: profile.id, state: 'connecting' });
      try {
        updateStatus(await invoke<RemoteDriveStatus>('connect_remote_drive', { profile }));
      } catch (error) {
        updateStatus({ id: profile.id, state: 'error', error: String(error) });
      }
    },
    [updateStatus]
  );

  const disconnect = useCallback(
    async (profile: RemoteDriveProfile, force = false) => {
      const result = await invoke<DisconnectResult>('disconnect_remote_drive', {
        id: profile.id,
        force,
      });
      updateStatus(result.status);
      return result;
    },
    [updateStatus]
  );

  useEffect(() => {
    void refreshEnvironment();
    const refreshStatuses = () =>
      invoke<RemoteDriveStatus[]>('get_remote_drive_statuses')
        .then((items) => items.forEach(updateStatus))
        .catch(() => {});
    void refreshStatuses();
    const statusTimer = window.setInterval(refreshStatuses, 5000);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    void listen<RemoteDriveStatus>('remote-drive-status', (event) =>
      updateStatus(event.payload)
    ).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    void listen<RemoteDriveExitBlocker>('remote-drive-exit-blocked', (event) => {
      const { pendingUploads, erroredFiles, error } = event.payload;
      const detail =
        error ?? `${pendingUploads} upload(s) are pending and ${erroredFiles} file(s) have errors.`;
      if (window.confirm(`${detail}\n\nForce quit and preserve the VFS cache for recovery?`)) {
        void invoke('force_remote_drive_shutdown');
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlistenExit = cleanup;
    });
    return () => {
      window.clearInterval(statusTimer);
      disposed = true;
      unlisten?.();
      unlistenExit?.();
    };
  }, [refreshEnvironment, updateStatus]);

  useEffect(() => {
    if (!environment || autoStarted.current || !environment.rcloneAvailable) return;
    if (environment.platform === 'windows' && environment.winfspAvailable === false) return;
    if (environment.platform === 'macos' && environment.helperStatus !== 'enabled') return;
    autoStarted.current = true;
    void (async () => {
      for (const profile of profiles) await connect(profile);
    })();
  }, [connect, environment, profiles]);

  const persist = (next: RemoteDriveProfile[]) => {
    saveRemoteDrives(next);
    setProfiles(next);
  };

  const saveProfile = async (profile: RemoteDriveProfile) => {
    const previous = profiles.find((item) => item.id === profile.id);
    if (previous && statuses[profile.id]?.state === 'connected') {
      const result = await disconnect(previous);
      if (result.blocked) {
        const confirmed = window.confirm(
          `This drive still has ${result.pendingUploads} upload(s) or ${result.erroredFiles} error(s). Disconnect while preserving its cache?`
        );
        if (!confirmed) return;
        await disconnect(previous, true);
      }
    }
    persist([...profiles.filter((item) => item.id !== profile.id), profile]);
    setEditing(null);
    await connect(profile);
  };

  const removeProfile = async (profile: RemoteDriveProfile) => {
    try {
      const result = await disconnect(profile);
      if (result.blocked) {
        window.alert(
          `Wait for ${result.pendingUploads} upload(s) and resolve ${result.erroredFiles} error(s) before removing this drive.`
        );
        return;
      }
      persist(profiles.filter((item) => item.id !== profile.id));
      setStatuses((current) => {
        const next = { ...current };
        delete next[profile.id];
        return next;
      });
    } catch (error) {
      updateStatus({ id: profile.id, state: 'error', error: String(error) });
    }
  };

  const disconnectWithConfirmation = async (profile: RemoteDriveProfile) => {
    try {
      const result = await disconnect(profile);
      if (!result.blocked) return;
      const confirmed = window.confirm(
        `This drive still has ${result.pendingUploads} upload(s) or ${result.erroredFiles} error(s). Disconnect while preserving its cache?`
      );
      if (confirmed) await disconnect(profile, true);
    } catch (error) {
      updateStatus({ id: profile.id, state: 'error', error: String(error) });
    }
  };

  const registerHelper = async () => {
    try {
      const helperStatus = await invoke<string>('register_remote_drive_helper');
      setEnvironment((current) => (current ? { ...current, helperStatus } : current));
      if (helperStatus === 'approval-required') {
        await invoke('open_remote_drive_helper_settings');
      }
    } catch (error) {
      setSetupError(String(error));
    }
  };

  const installWinFsp = async () => {
    setInstallingWinFsp(true);
    setSetupError(null);
    try {
      await invoke('install_winfsp');
      await refreshEnvironment();
    } catch (error) {
      setSetupError(String(error));
    } finally {
      setInstallingWinFsp(false);
    }
  };

  const openEditor = (profile?: RemoteDriveProfile, availableRemotes = remotes) => {
    const platform = environment?.platform;
    const occupied = new Set([
      ...profiles.map((item) => item.mountTarget.toLowerCase()),
      ...(environment?.occupiedMountTargets ?? []).map((target) => target.toLowerCase()),
    ]);
    const defaultWindowsTarget = WINDOWS_LETTERS.map((letter) => `${letter}:`).find(
      (target) => !occupied.has(target.toLowerCase())
    );
    setEditing(
      profile ?? {
        id: globalThis.crypto.randomUUID(),
        name: '',
        remote: availableRemotes[0] ?? '',
        remotePath: '',
        mountTarget: platform === 'windows' ? (defaultWindowsTarget ?? '') : '',
      }
    );
  };

  const configureRemotes = async () => {
    setConfiguringRemotes(true);
    setSetupError(null);
    try {
      await invoke('configure_rclone');
      const next = await invoke<string[]>('list_rclone_remotes');
      setRemotes(next);
      if (next.length > 0) openEditor(undefined, next);
      else setSetupError('rclone finished without creating a remote.');
    } catch (error) {
      setSetupError(String(error));
    } finally {
      setConfiguringRemotes(false);
    }
  };

  return (
    <section className={styles.section} aria-labelledby="remote-drives-title">
      <div className={styles.heading}>
        <span id="remote-drives-title">Remote Drives</span>
        <div className={styles.headingActions}>
          <button
            type="button"
            disabled={configuringRemotes}
            onClick={() => void configureRemotes()}
          >
            {configuringRemotes ? 'Configuring…' : 'Configure'}
          </button>
          <button type="button" aria-label="Add remote drive" onClick={() => openEditor()}>
            <Icon name="plus" size={13} />
          </button>
        </div>
      </div>

      {setupError && (
        <div className={styles.setup} aria-live="polite">
          <span>{setupError}</span>
          <button type="button" onClick={() => void refreshEnvironment()}>
            Retry
          </button>
        </div>
      )}
      {environment?.platform === 'windows' && environment.winfspAvailable === false && (
        <div className={styles.setup}>
          <span>Remote Drives need the Windows filesystem driver.</span>
          <button type="button" disabled={installingWinFsp} onClick={() => void installWinFsp()}>
            {installingWinFsp ? 'Installing WinFsp…' : 'Install WinFsp'}
          </button>
          <small>
            WinFsp - Windows File System Proxy, Copyright © Bill Zissimopoulos.{' '}
            <a href="https://github.com/winfsp/winfsp" target="_blank" rel="noopener noreferrer">
              Source and license
            </a>
          </small>
        </div>
      )}
      {environment?.platform === 'macos' && environment.helperStatus !== 'enabled' && (
        <div className={styles.setup}>
          <span>Approve the privileged mount helper.</span>
          <button type="button" onClick={() => void registerHelper()}>
            Enable
          </button>
          <button type="button" onClick={() => void refreshEnvironment()}>
            Check approval
          </button>
        </div>
      )}
      {environment?.platform === 'macos' &&
        environment.helperStatus === 'enabled' &&
        profiles.length === 0 && (
          <div className={styles.setup}>
            <button
              type="button"
              onClick={() =>
                void invoke('unregister_remote_drive_helper').then(() => refreshEnvironment())
              }
            >
              Remove privileged helper
            </button>
          </div>
        )}

      <div className={styles.list}>
        {profiles.map((profile) => {
          const driveStatus = statuses[profile.id] ?? disconnected(profile.id);
          const canOpen = driveStatus.state === 'connected' && driveStatus.mountPath;
          return (
            <div className={styles.item} key={profile.id}>
              <button
                type="button"
                className={styles.drive}
                title={driveStatus.error ?? driveStatus.mountPath ?? profile.mountTarget}
                onClick={() =>
                  canOpen ? onSelectLocation(driveStatus.mountPath!) : void connect(profile)
                }
              >
                <Icon name="hard-drive" />
                <span>{profile.name}</span>
                <span className={`${styles.dot} ${styles[driveStatus.state]}`} aria-hidden="true" />
              </button>
              <div className={styles.actions}>
                {driveStatus.state === 'connected' && (
                  <button
                    type="button"
                    aria-label={`Disconnect ${profile.name}`}
                    onClick={() => void disconnectWithConfirmation(profile)}
                  >
                    <Icon name="stop" size={12} />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Edit ${profile.name}`}
                  onClick={() => openEditor(profile)}
                >
                  <Icon name="edit" size={12} />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${profile.name}`}
                  onClick={() => void removeProfile(profile)}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            </div>
          );
        })}
        {profiles.length === 0 && !setupError && (
          <button type="button" className={styles.empty} onClick={() => void configureRemotes()}>
            Configure your first remote
          </button>
        )}
      </div>

      {editing && environment && (
        <RemoteDriveEditor
          environment={environment}
          profile={editing}
          profiles={profiles}
          remotes={remotes}
          onCancel={() => setEditing(null)}
          onSave={saveProfile}
        />
      )}
    </section>
  );
}

function RemoteDriveEditor({
  environment,
  profile,
  profiles,
  remotes,
  onCancel,
  onSave,
}: {
  environment: RemoteDriveEnvironment;
  profile: RemoteDriveProfile;
  profiles: RemoteDriveProfile[];
  remotes: string[];
  onCancel: () => void;
  onSave: (profile: RemoteDriveProfile) => Promise<void>;
}) {
  const [draft, setDraft] = useState(profile);
  const [saving, setSaving] = useState(false);
  const reservedTargets = new Set(
    [
      ...profiles.filter((item) => item.id !== profile.id).map((item) => item.mountTarget),
      ...environment.occupiedMountTargets.filter(
        (target) => target.toLowerCase() !== profile.mountTarget.toLowerCase()
      ),
    ].map((target) => target.toLowerCase())
  );
  const valid =
    draft.name.trim() &&
    draft.remote &&
    draft.mountTarget.trim() &&
    !reservedTargets.has(draft.mountTarget.toLowerCase());
  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onCancel}>
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-drive-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || saving) return;
          setSaving(true);
          void onSave({ ...draft, name: draft.name.trim(), remotePath: draft.remotePath.trim() })
            .catch(() => {})
            .finally(() => setSaving(false));
        }}
      >
        <h2 id="remote-drive-dialog-title">Remote Drive</h2>
        <label>
          Name
          <input
            autoFocus
            maxLength={64}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label>
          rclone remote
          <select
            value={draft.remote}
            onChange={(event) => setDraft({ ...draft, remote: event.target.value })}
          >
            <option value="">Select a remote</option>
            {remotes.map((remote) => (
              <option value={remote} key={remote}>
                {remote}
              </option>
            ))}
          </select>
        </label>
        <label>
          Subpath (optional)
          <input
            placeholder="folder/subfolder"
            value={draft.remotePath}
            onChange={(event) => setDraft({ ...draft, remotePath: event.target.value })}
          />
        </label>
        <label>
          {environment.platform === 'windows' ? 'Drive letter' : 'Volume name'}
          {environment.platform === 'windows' ? (
            <select
              value={draft.mountTarget.toUpperCase()}
              onChange={(event) => setDraft({ ...draft, mountTarget: event.target.value })}
            >
              {WINDOWS_LETTERS.filter(
                (letter) => !reservedTargets.has(`${letter}:`.toLowerCase())
              ).map((letter) => (
                <option value={`${letter}:`} key={letter}>{`${letter}:`}</option>
              ))}
            </select>
          ) : (
            <input
              maxLength={64}
              value={draft.mountTarget}
              onChange={(event) => setDraft({ ...draft, mountTarget: event.target.value })}
            />
          )}
        </label>
        <div className={styles.dialogActions}>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={!valid || saving}>
            Save & Connect
          </button>
        </div>
      </form>
    </div>
  );
}
