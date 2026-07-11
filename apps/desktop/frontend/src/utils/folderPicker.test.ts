import { beforeEach, describe, expect, it, vi } from 'vitest';
import { open } from '@tauri-apps/plugin-dialog';
import { chooseFolder } from './folderPicker';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

describe('chooseFolder', () => {
  beforeEach(() => {
    vi.mocked(open).mockReset();
  });

  it('opens a single-directory picker and returns the selected path', async () => {
    vi.mocked(open).mockResolvedValue('C:\\Users\\USER\\Documents');

    await expect(chooseFolder('C:\\Users\\USER')).resolves.toBe('C:\\Users\\USER\\Documents');
    expect(open).toHaveBeenCalledWith({
      title: 'Choose a folder',
      directory: true,
      multiple: false,
      defaultPath: 'C:\\Users\\USER',
    });
  });

  it('returns null when the picker is cancelled', async () => {
    vi.mocked(open).mockResolvedValue(null);

    await expect(chooseFolder()).resolves.toBeNull();
  });

  it('surfaces native picker failures to the recovery UI', async () => {
    vi.mocked(open).mockRejectedValue(new Error('Dialog unavailable'));

    await expect(chooseFolder()).rejects.toThrow('Dialog unavailable');
  });
});
