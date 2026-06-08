import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import styles from './Sidebar.module.css'; // Import CSS Module
import { Icon } from './Icon';
import type { IconName } from '../icons';
import type { SystemLocations } from '../hooks/useInitialPath';
import type { FavoriteItem, SmartFolder } from '../store';
import { useFileStore } from '../store';
import { basename } from '../utils/path';
import { buildTrashPath, ensureTrashDirForHome } from '../utils/trash';
import { reportError } from '../utils/errorReporter';

export function Sidebar({
  onSelectLocation,
  recents,
  onOpenSettings,
}: {
  recents?: string[];
  onSelectLocation?: (path: string) => void;
  onOpenSettings?: () => void;
}) {
  const [locations, setLocations] = useState<SystemLocations | null>(null);
  const [recentsExpanded, setRecentsExpanded] = useState<boolean>(() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:recentsExpanded');
        if (v === 'true') return true;
        if (v === 'false') return false;
      }
    } catch {}
    return true;
  });

  useEffect(() => {
    invoke<SystemLocations>('list_system_locations')
      .then(setLocations)
      .catch(() => setLocations(null));
  }, []);

  const defaultExplorerSupported = useFileStore((s) => s.defaultExplorerSupported);
  const defaultExplorerEnabled = useFileStore((s) => s.defaultExplorerEnabled);
  const defaultExplorerLoading = useFileStore((s) => s.defaultExplorerLoading);
  const defaultExplorerError = useFileStore((s) => s.defaultExplorerError);
  const refreshDefaultExplorer = useFileStore((s) => s.refreshDefaultExplorer);
  const makeDefaultExplorer = useFileStore((s) => s.makeDefaultExplorer);
  const clearDefaultExplorerError = useFileStore((s) => s.clearDefaultExplorerError);

  // User favorites
  const favorites = useFileStore((s) => s.favorites);
  const removeFavorite = useFileStore((s) => s.removeFavorite);
  const reorderFavorites = useFileStore((s) => s.reorderFavorites);
  const renameFavorite = useFileStore((s) => s.renameFavorite);

  // Smart Folders (Saved Searches)
  const smartFolders = useFileStore((s) => s.smartFolders);
  const deleteSmartFolder = useFileStore((s) => s.deleteSmartFolder);
  const setSearchQuery = useFileStore((s) => s.setSearchQuery);
  const setFilterMode = useFileStore((s) => s.setFilterMode);
  const setActiveSmartFolderId = useFileStore((s) => s.setActiveSmartFolderId);
  const setViewMode = useFileStore((s) => s.setViewMode);

  // Drag and drop state for favorites reordering
  const [draggedFavIndex, setDraggedFavIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Inline editing state for favorite renaming
  const [editingFavPath, setEditingFavPath] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');

  const [favoritesExpanded, setFavoritesExpanded] = useState<boolean>(() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:favoritesExpanded');
        if (v === 'false') return false;
      }
    } catch {}
    return true;
  });

  const [smartFoldersExpanded, setSmartFoldersExpanded] = useState<boolean>(() => {
    try {
      if (typeof window !== 'undefined') {
        const v = window.localStorage.getItem('explorie:smartFoldersExpanded');
        if (v === 'false') return false;
      }
    } catch {}
    return true;
  });

  // Persist favorites expanded state
  useEffect(() => {
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('explorie:favoritesExpanded', String(favoritesExpanded));
    } catch {}
  }, [favoritesExpanded]);

  // Persist smart folders expanded state
  useEffect(() => {
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('explorie:smartFoldersExpanded', String(smartFoldersExpanded));
    } catch {}
  }, [smartFoldersExpanded]);

  // Get sorted smart folder list
  const smartFolderList = Object.values(smartFolders).sort((a, b) => b.updatedAt - a.updatedAt);

  // Handle activating a smart folder (apply its search criteria)
  const handleSmartFolderClick = useCallback(
    (sf: SmartFolder) => {
      setActiveSmartFolderId(sf.id);
      setViewMode('list');
      if (sf.criteria.namePattern && !sf.criteria.nameRegex) {
        setSearchQuery(sf.criteria.namePattern);
      } else {
        setSearchQuery('');
      }
      setFilterMode(sf.criteria.typeFilter ?? 'all');
      if (sf.criteria.searchPaths?.length > 0) {
        onSelectLocation?.(sf.criteria.searchPaths[0]);
      }
    },
    [onSelectLocation, setActiveSmartFolderId, setViewMode, setSearchQuery, setFilterMode]
  );

  // Handle removing a smart folder
  const handleRemoveSmartFolder = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      deleteSmartFolder(id);
    },
    [deleteSmartFolder]
  );

  // Handle remove favorite with context menu
  const handleRemoveFavorite = useCallback(
    (path: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      removeFavorite(path);
    },
    [removeFavorite]
  );

  // Drag handlers for favorites reordering
  const handleFavDragStart = useCallback((index: number, e: React.DragEvent) => {
    setDraggedFavIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleFavDragOver = useCallback(
    (index: number, e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (draggedFavIndex !== null && draggedFavIndex !== index) {
        setDragOverIndex(index);
      }
    },
    [draggedFavIndex]
  );

  const handleFavDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  const handleFavDrop = useCallback(
    (targetIndex: number, e: React.DragEvent) => {
      e.preventDefault();
      if (draggedFavIndex === null || draggedFavIndex === targetIndex) {
        setDraggedFavIndex(null);
        setDragOverIndex(null);
        return;
      }

      // Reorder the favorites array
      const newFavorites = [...favorites];
      const [draggedItem] = newFavorites.splice(draggedFavIndex, 1);
      newFavorites.splice(targetIndex, 0, draggedItem);
      reorderFavorites(newFavorites);

      setDraggedFavIndex(null);
      setDragOverIndex(null);
    },
    [draggedFavIndex, favorites, reorderFavorites]
  );

  const handleFavDragEnd = useCallback(() => {
    setDraggedFavIndex(null);
    setDragOverIndex(null);
  }, []);

  // Inline edit handlers for favorite renaming
  const handleStartRename = useCallback((fav: FavoriteItem) => {
    setEditingFavPath(fav.path);
    setEditingName(fav.name);
  }, []);

  const handleConfirmRename = useCallback(() => {
    if (editingFavPath && editingName.trim()) {
      renameFavorite(editingFavPath, editingName.trim());
    }
    setEditingFavPath(null);
    setEditingName('');
  }, [editingFavPath, editingName, renameFavorite]);

  const handleCancelRename = useCallback(() => {
    setEditingFavPath(null);
    setEditingName('');
  }, []);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirmRename();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancelRename();
      }
    },
    [handleConfirmRename, handleCancelRename]
  );

  useEffect(() => {
    if (!defaultExplorerSupported) return;
    refreshDefaultExplorer().catch((err) => {
      reportError('Failed to check default explorer status', err, { warning: true });
    });
  }, [defaultExplorerSupported, refreshDefaultExplorer]);

  const handleMakeDefaultExplorer = async () => {
    clearDefaultExplorerError();
    try {
      await makeDefaultExplorer();
    } catch (err) {
      reportError('Failed to set as default explorer', err);
    }
  };

  // Persist recents collapsed/expanded state
  useEffect(() => {
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem('explorie:recentsExpanded', String(recentsExpanded));
    } catch {}
  }, [recentsExpanded]);

  // Click handler that forwards selection
  const handleSelect = (path: string) => {
    setActiveSmartFolderId(null);
    onSelectLocation?.(path);
  };

  // Helper component for location items
  const LocationItem = ({
    path,
    label,
    icon,
    onClick,
  }: {
    path: string;
    label: string;
    icon: IconName;
    onClick?: (path: string) => void | Promise<void>;
  }) => (
    <button
      className={styles.locationItem}
      aria-label={`Go to ${label}`}
      onClick={() => {
        void onClick?.(path);
      }}
    >
      <span className={styles.locationIcon}>
        <Icon name={icon} />
      </span>
      {label}
    </button>
  );

  const trashPath = useMemo(() => {
    if (!locations?.home) return null;
    return buildTrashPath(locations.home);
  }, [locations?.home]);

  const handleSelectTrash = useCallback(
    async (_path: string) => {
      if (!locations?.home) return;
      const trashDir = await ensureTrashDirForHome(locations.home);
      if (trashDir) {
        setActiveSmartFolderId(null);
        onSelectLocation?.(trashDir);
      }
    },
    [locations?.home, onSelectLocation, setActiveSmartFolderId]
  );

  return (
    <div className={styles.sidebar}>
      <div className={styles.scrollRegion}>
        {/* App logo/title removed per design */}
        {/* User Favorites Section */}
        <div className={styles.section}>
          <button
            className={styles.sectionTitle}
            aria-expanded={favoritesExpanded}
            aria-controls="favorites-list"
            onClick={() => setFavoritesExpanded((v) => !v)}
          >
            <Icon name={favoritesExpanded ? 'arrow-down' : 'arrow-right'} size={12} />
            Favorites
          </button>
          {favoritesExpanded && (
            <div id="favorites-list" className={styles.locationList}>
              {favorites.length > 0 ? (
                favorites.map((fav, index) => (
                  <div
                    key={fav.path}
                    className={`${styles.favoriteItemWrapper} ${draggedFavIndex === index ? styles.dragging : ''} ${dragOverIndex === index ? styles.dragOver : ''}`}
                    draggable={editingFavPath !== fav.path}
                    onDragStart={(e) => handleFavDragStart(index, e)}
                    onDragOver={(e) => handleFavDragOver(index, e)}
                    onDragLeave={handleFavDragLeave}
                    onDrop={(e) => handleFavDrop(index, e)}
                    onDragEnd={handleFavDragEnd}
                  >
                    {editingFavPath === fav.path ? (
                      <div className={styles.favoriteEditWrapper}>
                        <span className={styles.locationIcon}>
                          <Icon name="star" />
                        </span>
                        <input
                          type="text"
                          className={styles.favoriteEditInput}
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={handleRenameKeyDown}
                          onBlur={handleConfirmRename}
                          autoFocus
                        />
                      </div>
                    ) : (
                      <button
                        className={styles.locationItem}
                        aria-label={`Go to ${fav.name}`}
                        onClick={() => handleSelect(fav.path)}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleStartRename(fav);
                        }}
                        title="Double-click to rename"
                      >
                        <span className={styles.locationIcon}>
                          <Icon name="star" />
                        </span>
                        {fav.name}
                      </button>
                    )}
                    <button
                      className={styles.removeFavoriteBtn}
                      onClick={(e) => handleRemoveFavorite(fav.path, e)}
                      title="Remove from favorites"
                      aria-label={`Remove ${fav.name} from favorites`}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                ))
              ) : (
                <div className={styles.loadingText}>
                  No favorites yet.
                  <br />
                  <span className={styles.hintText}>Use Ctrl+D to bookmark folders</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Smart Folders (Saved Searches) Section */}
        {smartFolderList.length > 0 && (
          <div className={styles.section}>
            <button
              className={styles.sectionTitle}
              aria-expanded={smartFoldersExpanded}
              aria-controls="smart-folders-list"
              onClick={() => setSmartFoldersExpanded((v) => !v)}
            >
              <Icon name={smartFoldersExpanded ? 'arrow-down' : 'arrow-right'} size={12} />
              Smart Folders
            </button>
            {smartFoldersExpanded && (
              <div id="smart-folders-list" className={styles.locationList}>
                {smartFolderList.map((sf) => (
                  <div key={sf.id} className={styles.favoriteItemWrapper}>
                    <button
                      className={styles.locationItem}
                      aria-label={`Open ${sf.name}`}
                      onClick={() => handleSmartFolderClick(sf)}
                      title={`Search: ${sf.criteria.namePattern || 'all'} in ${sf.criteria.searchPaths?.join(', ') || 'all locations'}`}
                    >
                      <span className={styles.locationIcon}>
                        <Icon name="search" />
                      </span>
                      {sf.name}
                    </button>
                    <button
                      className={styles.removeFavoriteBtn}
                      onClick={(e) => handleRemoveSmartFolder(sf.id, e)}
                      title="Delete smart folder"
                      aria-label={`Delete ${sf.name}`}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Recents Section */}
        <div className={styles.section}>
          <button
            className={styles.sectionTitle}
            aria-expanded={recentsExpanded}
            aria-controls="recents-list"
            onClick={() => setRecentsExpanded((v) => !v)}
          >
            <Icon name={recentsExpanded ? 'arrow-down' : 'arrow-right'} size={12} />
            Recents
          </button>
          {recentsExpanded && (
            <div id="recents-list" className={styles.locationList}>
              {recents && recents.length > 0 ? (
                recents.map((p) => {
                  const label = basename(p);
                  return (
                    <LocationItem
                      key={p}
                      path={p}
                      label={label}
                      icon="clock"
                      onClick={handleSelect}
                    />
                  );
                })
              ) : (
                <div className={styles.loadingText}>No recent locations</div>
              )}
            </div>
          )}
        </div>

        {/* System Locations Section */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Locations</div>
          <div className={styles.locationList}>
            {locations ? (
              <>
                {locations.desktop && (
                  <LocationItem
                    path={locations.desktop}
                    label="Desktop"
                    icon="monitor"
                    onClick={handleSelect}
                  />
                )}
                {locations.documents && (
                  <LocationItem
                    path={locations.documents}
                    label="Documents"
                    icon="file"
                    onClick={handleSelect}
                  />
                )}
                {locations.downloads && (
                  <LocationItem
                    path={locations.downloads}
                    label="Downloads"
                    icon="download"
                    onClick={handleSelect}
                  />
                )}
                {locations.music && (
                  <LocationItem
                    path={locations.music}
                    label="Music"
                    icon="music"
                    onClick={handleSelect}
                  />
                )}
                {locations.pictures && (
                  <LocationItem
                    path={locations.pictures}
                    label="Pictures"
                    icon="image"
                    onClick={handleSelect}
                  />
                )}
                {locations.videos && (
                  <LocationItem
                    path={locations.videos}
                    label="Videos"
                    icon="video"
                    onClick={handleSelect}
                  />
                )}
                {locations.home && (
                  <LocationItem
                    path={locations.home}
                    label="Home"
                    icon="home"
                    onClick={handleSelect}
                  />
                )}
                {trashPath && (
                  <LocationItem
                    path={trashPath}
                    label="Trash"
                    icon="trash"
                    onClick={handleSelectTrash}
                  />
                )}
              </>
            ) : (
              <div className={styles.loadingText}>Loading…</div>
            )}
          </div>
        </div>

        {/* Drives Section */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Drives</div>
          <div className={styles.locationList}>
            {locations ? (
              locations.drives.length > 0 ? (
                locations.drives.map((drive) => (
                  <LocationItem
                    key={drive}
                    path={drive}
                    label={drive}
                    icon="hard-drive"
                    onClick={handleSelect}
                  />
                ))
              ) : (
                <div className={styles.loadingText}>No drives found</div>
              )
            ) : (
              <div className={styles.loadingText}>Loading…</div>
            )}
          </div>
        </div>
      </div>

      <div className={styles.sidebarFooter}>
        {/* Bottom Controls */}
        <div className={styles.bottomControls}>
          {defaultExplorerSupported && defaultExplorerEnabled === false && (
            <button
              className={`${styles.controlButton} ${styles.makeDefaultButton}`}
              onClick={handleMakeDefaultExplorer}
              disabled={defaultExplorerLoading}
              aria-busy={defaultExplorerLoading}
            >
              <Icon name={defaultExplorerLoading ? 'loader' : 'chevrons-horizontal'} />{' '}
              {defaultExplorerLoading ? 'Setting\u2026' : 'Make explorie default'}
            </button>
          )}
          {defaultExplorerSupported && defaultExplorerError && (
            <div className={styles.defaultExplorerError} role="status">
              {defaultExplorerError}
            </div>
          )}
          <button className={styles.controlButton} onClick={onOpenSettings} aria-haspopup="dialog">
            <Icon name="sliders" /> Settings
          </button>
        </div>

        {/* Version Info */}
        <div className={styles.versionInfo}>
          v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'}
          {typeof __GIT_HASH__ !== 'undefined' && __GIT_HASH__ !== 'unknown'
            ? ` · ${__GIT_HASH__}`
            : ''}
        </div>
      </div>
    </div>
  );
}
