import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteDrivesSection } from './RemoteDrivesSection';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

const environment = {
  platform: 'windows',
  rcloneAvailable: true,
  rcloneVersion: 'rclone v1.70.0',
  winfspAvailable: true,
  helperStatus: null,
  occupiedMountTargets: ['D:'],
  error: null,
};

describe('RemoteDrivesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    invokeMock.mockImplementation((command: string, args?: { profile?: { id: string } }) => {
      if (command === 'get_remote_drive_environment') return Promise.resolve(environment);
      if (command === 'list_rclone_remotes') return Promise.resolve(['cloud', 'backup']);
      if (command === 'get_remote_drive_statuses') return Promise.resolve([]);
      if (command === 'connect_remote_drive') {
        return Promise.resolve({
          id: args?.profile?.id,
          state: 'connected',
          mountPath: 'E:\\',
        });
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(cleanup);

  it('adds a sanitized profile using an available mount target', async () => {
    const user = userEvent.setup();
    render(<RemoteDrivesSection onSelectLocation={vi.fn()} />);

    await user.click(await screen.findByLabelText('Add remote drive'));
    await user.type(screen.getByLabelText('Name'), 'Projects');
    await user.selectOptions(screen.getByLabelText('rclone remote'), 'cloud');
    await user.type(screen.getByLabelText('Subpath (optional)'), 'work');
    expect(screen.getByLabelText('Drive letter')).toHaveValue('E:');
    await user.click(screen.getByRole('button', { name: 'Save & Connect' }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        'connect_remote_drive',
        expect.objectContaining({ profile: expect.objectContaining({ name: 'Projects' }) })
      )
    );
    const saved = JSON.parse(window.localStorage.getItem('explorie:remoteDrives') ?? '[]');
    expect(saved).toEqual([
      expect.objectContaining({
        name: 'Projects',
        remote: 'cloud',
        remotePath: 'work',
        mountTarget: 'E:',
      }),
    ]);
  });

  it('auto-connects profiles sequentially and continues after a failure', async () => {
    const profiles = [
      {
        id: '672ce77a-b72d-4e16-a9e8-55e0ac5bc580',
        name: 'First',
        remote: 'cloud',
        remotePath: '',
        mountTarget: 'E:',
      },
      {
        id: 'f42baa4e-3ce4-4a2c-a8c6-7c747f830c1f',
        name: 'Second',
        remote: 'backup',
        remotePath: '',
        mountTarget: 'F:',
      },
    ];
    window.localStorage.setItem('explorie:remoteDrives', JSON.stringify(profiles));
    invokeMock.mockImplementation((command: string, args?: { profile?: { id: string } }) => {
      if (command === 'get_remote_drive_environment') return Promise.resolve(environment);
      if (command === 'list_rclone_remotes') return Promise.resolve(['cloud', 'backup']);
      if (command === 'get_remote_drive_statuses') return Promise.resolve([]);
      if (command === 'connect_remote_drive' && args?.profile?.id === profiles[0].id) {
        return Promise.reject(new Error('offline'));
      }
      if (command === 'connect_remote_drive') {
        return Promise.resolve({ id: profiles[1].id, state: 'connected', mountPath: 'F:\\' });
      }
      return Promise.resolve(undefined);
    });

    render(<RemoteDrivesSection onSelectLocation={vi.fn()} />);

    await waitFor(() => {
      const connects = invokeMock.mock.calls.filter(
        ([command]) => command === 'connect_remote_drive'
      );
      expect(connects.map(([, args]) => args.profile.id)).toEqual(profiles.map(({ id }) => id));
    });
    expect(await screen.findByText('Second')).toBeInTheDocument();
  });

  it('offers the bundled WinFsp installer and refreshes after installation', async () => {
    const user = userEvent.setup();
    let environmentChecks = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_remote_drive_environment') {
        environmentChecks += 1;
        return Promise.resolve({
          ...environment,
          winfspAvailable: environmentChecks > 1,
        });
      }
      if (command === 'list_rclone_remotes') return Promise.resolve(['cloud']);
      if (command === 'get_remote_drive_statuses') return Promise.resolve([]);
      if (command === 'install_winfsp') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    render(<RemoteDrivesSection onSelectLocation={vi.fn()} />);

    const install = await screen.findByRole('button', { name: 'Install WinFsp' });
    expect(screen.getByRole('link', { name: 'Source and license' })).toHaveAttribute(
      'href',
      'https://github.com/winfsp/winfsp'
    );
    await user.click(install);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('install_winfsp', undefined));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Install WinFsp' })).not.toBeInTheDocument()
    );
  });

  it('opens rclone configuration and starts adding the new remote', async () => {
    const user = userEvent.setup();
    render(<RemoteDrivesSection onSelectLocation={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Configure' }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('configure_rclone', undefined));
    expect(await screen.findByRole('dialog', { name: 'Remote Drive' })).toBeInTheDocument();
    expect(screen.getByLabelText('rclone remote')).toHaveValue('cloud');
  });
});
