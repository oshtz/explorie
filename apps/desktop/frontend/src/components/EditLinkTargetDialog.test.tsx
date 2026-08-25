import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../utils/accessibility', () => ({
  createFocusTrap: () => ({
    activate: vi.fn(),
    deactivate: vi.fn(),
    handleKeyDown: vi.fn(),
  }),
}));

import { EditLinkTargetDialog } from './EditLinkTargetDialog';

const link: FileEntry = {
  id: '/workspace/report-link',
  path: '/workspace/report-link',
  name: 'report-link',
  size: 1,
  modified: 0,
  is_dir: false,
  is_symlink: true,
  link_target: '../report.txt',
  custom: {},
};

describe('EditLinkTargetDialog', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValueOnce({
      kind: 'symlink_file',
      target: '../report.txt',
      resolved_target: '/workspace/report.txt',
      target_exists: true,
      target_is_dir: false,
    });
  });

  afterEach(() => cleanup());

  it('loads the current target and writes an edited target', async () => {
    const onClose = vi.fn();
    const onSuccess = vi.fn();

    render(<EditLinkTargetDialog open file={link} onClose={onClose} onSuccess={onSuccess} />);

    const input = await screen.findByDisplayValue('../report.txt');
    fireEvent.change(input, { target: { value: '../renamed-report.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith('set_link_target', {
        path: '/workspace/report-link',
        target: '../renamed-report.txt',
      })
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
