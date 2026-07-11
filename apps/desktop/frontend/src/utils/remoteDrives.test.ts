import { beforeEach, describe, expect, it } from 'vitest';
import { loadRemoteDrives, saveRemoteDrives, type RemoteDriveProfile } from './remoteDrives';

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
