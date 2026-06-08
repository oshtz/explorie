import { create } from 'zustand';
import {
  checkForUpdate,
  downloadUpdate,
  getCurrentVersion,
  installUpdate,
} from './services/updater';
import type { UpdateInfo } from './services/updater';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'up-to-date'
  | 'error';

interface UpdateState {
  currentVersion: string | null;
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  updatePath: string | null;
  error: string | null;
  lastCheckedAt: number | null;
  loadCurrentVersion: () => Promise<void>;
  checkNow: () => Promise<UpdateInfo | null>;
  downloadNow: (info?: UpdateInfo) => Promise<string | null>;
  installNow: () => Promise<void>;
  clearError: () => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  currentVersion: null,
  status: 'idle',
  updateInfo: null,
  updatePath: null,
  error: null,
  lastCheckedAt: null,
  loadCurrentVersion: async () => {
    try {
      const version = await getCurrentVersion();
      set({ currentVersion: version });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },
  checkNow: async () => {
    set({ status: 'checking', error: null });
    try {
      const info = await checkForUpdate();
      const now = Date.now();
      if (info) {
        set({
          status: 'available',
          updateInfo: info,
          updatePath: null,
          lastCheckedAt: now,
        });
      } else {
        set({
          status: 'up-to-date',
          updateInfo: null,
          updatePath: null,
          lastCheckedAt: now,
        });
      }
      return info;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ status: 'error', error: message });
      return null;
    }
  },
  downloadNow: async (info?: UpdateInfo) => {
    const updateInfo = info ?? get().updateInfo;
    if (!updateInfo) {
      const message = 'No update information available.';
      set({ status: 'error', error: message });
      return null;
    }

    set({ status: 'downloading', error: null });
    try {
      const path = await downloadUpdate(updateInfo);
      set({ status: 'ready', updatePath: path });
      return path;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ status: 'error', error: message });
      return null;
    }
  },
  installNow: async () => {
    const path = get().updatePath;
    if (!path) {
      const message = 'No downloaded update available.';
      set({ status: 'error', error: message });
      return;
    }
    set({ status: 'installing', error: null });
    try {
      await installUpdate(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ status: 'error', error: message });
    }
  },
  clearError: () => set({ error: null }),
}));
