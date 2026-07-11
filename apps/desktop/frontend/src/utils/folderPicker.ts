import { open } from '@tauri-apps/plugin-dialog';

export async function chooseFolder(defaultPath?: string): Promise<string | null> {
  const selected = await open({
    title: 'Choose a folder',
    directory: true,
    multiple: false,
    ...(defaultPath ? { defaultPath } : {}),
  });

  if (Array.isArray(selected)) {
    return selected[0]?.trim() || null;
  }

  return typeof selected === 'string' && selected.trim() ? selected : null;
}
