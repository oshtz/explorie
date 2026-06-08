import type { StateCreator } from 'zustand';
import type { FavoritesSlice, StoreState, FavoriteItem } from '../types';
import { basename, normalizePathForCompare } from '../../utils/path';

function isFavoriteItem(value: unknown): value is FavoriteItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    'name' in value &&
    typeof value.path === 'string' &&
    typeof value.name === 'string'
  );
}

export const createFavoritesSlice: StateCreator<StoreState, [], [], FavoritesSlice> = (set) => ({
  favorites: (() => {
    try {
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem('explorie:favorites');
        const arr: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter(isFavoriteItem) : [];
      }
    } catch {}
    return [];
  })(),
  addFavorite: (path: string, name?: string) => {
    set((state) => {
      const normPath = normalizePathForCompare(path);
      if (state.favorites.some((f) => normalizePathForCompare(f.path) === normPath)) {
        return state;
      }
      const displayName = name || basename(normPath) || normPath;
      const next = [...state.favorites, { path: normPath, name: displayName }];
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('explorie:favorites', JSON.stringify(next));
        }
      } catch {}
      return { favorites: next };
    });
  },
  removeFavorite: (path: string) => {
    set((state) => {
      const normPath = normalizePathForCompare(path);
      const next = state.favorites.filter((f) => normalizePathForCompare(f.path) !== normPath);
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('explorie:favorites', JSON.stringify(next));
        }
      } catch {}
      return { favorites: next };
    });
  },
  renameFavorite: (path: string, newName: string) => {
    set((state) => {
      const normPath = normalizePathForCompare(path);
      const next = state.favorites.map((f) =>
        normalizePathForCompare(f.path) === normPath ? { ...f, name: newName } : f
      );
      try {
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('explorie:favorites', JSON.stringify(next));
        }
      } catch {}
      return { favorites: next };
    });
  },
  reorderFavorites: (favorites: FavoriteItem[]) => {
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('explorie:favorites', JSON.stringify(favorites));
      }
    } catch {}
    set({ favorites });
  },
});
