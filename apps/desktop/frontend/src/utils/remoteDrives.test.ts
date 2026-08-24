import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectRemoteDriveWithBackoff,
  loadRemoteDrives,
  saveRemoteDrives,
  type RemoteDriveProfile,
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

describe('connectRemoteDriveWithBackoff', () => {
  const profileId = '672ce77a-b72d-4e16-a9e8-55e0ac5bc580';

  it('retries a retryable failure with bounded backoff then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('rclone exited with exit status: 1'))
      .mockRejectedValueOnce(new Error('Timed out waiting for rclone to start.'))
      .mockResolvedValueOnce({ id: profileId, state: 'connected', mountPath: 'E:\\' });

    const status = await connectRemoteDriveWithBackoff(profileId, attempt, { sleep });

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);
    expect(status).toEqual({ id: profileId, state: 'connected', mountPath: 'E:\\' });
  });

  it('gives up after the retry budget without another attempt', async () => {
    const sleep = vi.fn(async () => {});
    const attempt = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const status = await connectRemoteDriveWithBackoff(profileId, attempt, { sleep });

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(status).toMatchObject({ id: profileId, state: 'error' });
    expect(status.error).toMatch(/connection refused/i);
  });

  it('does not auto-retry a missing WinFsp or unapproved helper', async () => {
    const sleep = vi.fn(async () => {});
    const winfsp = vi
      .fn()
      .mockRejectedValue(new Error('Install WinFsp before mounting remote drives on Windows.'));
    const helper = vi.fn().mockResolvedValue({ id: profileId, state: 'approval-required' });

    await connectRemoteDriveWithBackoff(profileId, winfsp, { sleep });
    await connectRemoteDriveWithBackoff(profileId, helper, { sleep });

    expect(winfsp).toHaveBeenCalledTimes(1);
    expect(helper).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
