import { create } from 'zustand';
import type { StoreState } from './store/types';
import { createFileSlice } from './store/slices/fileSlice';
import { createUISlice } from './store/slices/uiSlice';
import { createFavoritesSlice } from './store/slices/favoritesSlice';
import { createWorkspaceSlice } from './store/slices/workspaceSlice';

export type {
  FileModified,
  FileEntry,
  ThemeSpec,
  FavoriteItem,
  WorkspaceTab,
  Workspace,
  SmartFolderCriteria,
  SmartFolder,
} from './store/types';

// Re-export custom field types for convenience
export type {
  CustomFields,
  CustomFieldValue,
  CustomFieldPrimitive,
  CustomFieldArray,
  KnownFieldName,
  KnownFieldTypes,
  StatusValue,
  PriorityValue,
  TypeValue,
  CategoryValue,
} from './utils/customFieldTypes';

export const useFileStore = create<StoreState>()((...args) => ({
  ...createFileSlice(...args),
  ...createUISlice(...args),
  ...createFavoritesSlice(...args),
  ...createWorkspaceSlice(...args),
}));
