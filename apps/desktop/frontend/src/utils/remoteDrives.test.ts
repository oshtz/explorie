import { beforeEach, describe, expect, it } from 'vitest';
import {
  getRemoteDriveLifecycle,
  getRemoteDriveStatusMessage,
  loadRemoteDrives,
  REMOTE_DRIVE_CONNECTING_HUNG_AFTER_MS,
  saveRemoteDrives,
  type RemoteDriveProfile,
  type RemoteDriveStatus,
} from './remoteDrives';

describe('remote drive persistence', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips valid profiles and drops malformed records', () => {
    const profile: RemoteDriveProfile = {
      id: '672ce77a-b72d-4e16-a9e8-55e0ac5bc580',
      name: 'Archive',
      remote: 'cloud',
      remotePath: 'projects',
      mountTarget: 'R:',
    };
    expect(saveRemoteDrives([profile])).toBe(true);
    expect(loadRemoteDrives()).toEqual([profile]);

    window.localStorage.setItem(
      'explorie:remoteDrives',
      JSON.stringify([
        { ...profile, password: 'must-not-survive' },
        { id: 'bad', name: '', remote: null },
      ])
    );
    expect(loadRemoteDrives()).toEqual([profile]);

    saveRemoteDrives(loadRemoteDrives());
    expect(window.localStorage.getItem('explorie:remoteDrives')).not.toContain('password');
  });
});

describe('remote drive lifecycle messages', () => {
  it.each([
    ['connecting', 'Connecting'],
    ['connected', 'Connected'],
    ['disconnected', 'try the mount again'],
    ['disconnecting', 'pending remote writes'],
    ['approval-required', 'Approve'],
    ['error', 'Check the remote configuration'],
  ] as const)('maps %s to an actionable message', (state, expected) => {
    const status = { id: 'drive', state } as RemoteDriveStatus;
    expect(getRemoteDriveStatusMessage(status)).toContain(expected);
  });

  it('prefers the backend message so configuration details survive the mapping', () => {
    expect(
      getRemoteDriveStatusMessage({
        state: 'error',
        message: 'No rclone remotes are configured. Choose Configure to add one, then try again.',
      })
    ).toContain('No rclone remotes');
  });

  it('marks a long-running connection as hung without changing the backend state', () => {
    const status: RemoteDriveStatus = { id: 'drive', state: 'connecting' };
    const lifecycle = getRemoteDriveLifecycle(
      status,
      10_000,
      10_000 + REMOTE_DRIVE_CONNECTING_HUNG_AFTER_MS
    );
    expect(lifecycle).toEqual({
      state: 'hung',
      label: 'Still connecting',
      message: expect.stringContaining('bounded retries'),
    });
    expect(status.state).toBe('connecting');
  });

  it('keeps an active connection in the connected state before the hung threshold', () => {
    const lifecycle = getRemoteDriveLifecycle(
      { id: 'drive', state: 'connecting' },
      10_000,
      10_000 + REMOTE_DRIVE_CONNECTING_HUNG_AFTER_MS - 1
    );
    expect(lifecycle.state).toBe('connecting');
    expect(lifecycle.label).toBe('Connecting');
  });
});
