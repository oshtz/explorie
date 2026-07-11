import React, { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import styles from './Sidebar.module.css'; // Import CSS Module
import { Icon } from './Icon';
import type { IconName } from '../icons';
import type { SystemLocations } from '../hooks/useInitialPath';
import type { FavoriteItem, SmartFolder } from '../store';
import { useFileStore } from '../store';
import { basename, normalizePathForCompare } from '../utils/path';
import { reportError } from '../utils/errorReporter';
import { RemoteDrivesSection } from './RemoteDrivesSection';

export function Sidebar({
  onSelectLocation,
  recents,
  onOpenSettings,
  currentPath,
  fileDragActive = false,
  onFileDragHoverPath,
  onFileDragHoverFavorites,
  onFileDragOpenPath,
}: {
  recents?: string[];
  onSelectLocation?: (path: string) => void;
  onOpenSettings?: () => void;
  currentPath?: string;
  fileDragActive?: boolean;
  onFileDragHoverPath?: (path: string | null) => void;
  onFileDragHoverFavorites?: () => void;
  onFileDragOpenPath?: (path: string) => void;
}) {
  const [locations, setLocations] = useState<SystemLocations | null>(null);
  const [locationsError, setLocationsError] = useState<string | null>(null);
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

  const loadLocations = useCallback(() => {
    setLocations(null);
    setLocationsError(null);
    invoke<SystemLocations>('list_system_locations')
      .then(setLocations)
      .catch((error) => {
        const formatted = reportError('Failed to load system locations', error);
        setLocationsError(formatted.message);
      });
  }, []);

  useEffect(() => {
    loadLocations();
  }, [loadLocations]);

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
  const activeSmartFolderId = useFileStore((s) => s.activeSmartFolderId);
  const setViewMode = useFileStore((s) => s.setViewMode);

  // Drag and drop state for favorites reordering
  const [draggedFavIndex, setDraggedFavIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [favoritesFileDropOver, setFavoritesFileDropOver] = useState(false);
  const fileHoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFileHover = useCallback(() => {
    if (fileHoverTimerRef.current) clearTimeout(fileHoverTimerRef.current);
    fileHoverTimerRef.current = null;
  }, []);

  useEffect(() => () => clearFileHover(), [clearFileHover]);

  const handleFileHoverPath = useCallback(
    (path: string | null) => {
      if (!fileDragActive) return;
      clearFileHover();
      onFileDragHoverPath?.(path);
      if (path) {
        fileHoverTimerRef.current = setTimeout(() => onFileDragOpenPath?.(path), 700);
      }
    },
    [clearFileHover, fileDragActive, onFileDragHoverPath, onFileDragOpenPath]
  );

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

  const handleFavoriteKeyDown = useCallback(
    (index: number, event: React.KeyboardEvent) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      const target = Math.min(
        favorites.length - 1,
        Math.max(0, index + (event.key === 'ArrowUp' ? -1 : 1))
      );
      if (target === index) return;
      event.preventDefault();
      const next = [...favorites];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      reorderFavorites(next);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-favorite-index="${target}"]`)?.focus();
      });
    },
    [favorites, reorderFavorites]
  );

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

  const normalizedCurrentPath = currentPath ? normalizePathForCompare(currentPath) : '';
  const isCurrentPath = (path: string) =>
    normalizedCurrentPath !== '' && normalizePathForCompare(path) === normalizedCurrentPath;

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
  }) => {
    const isCurrent = isCurrentPath(path);
    return (
      <button
        className={`${styles.locationItem} ${isCurrent ? styles.locationItemActive : ''}`}
        aria-label={`Go to ${label}`}
        aria-current={isCurrent ? 'page' : undefined}
        title={path}
        onClick={() => {
          void onClick?.(path);
        }}
        onMouseEnter={() => handleFileHoverPath(path)}
        onMouseLeave={() => handleFileHoverPath(null)}
      >
        <span className={styles.locationIcon}>
          <Icon name={icon} />
        </span>
        <span className={styles.locationLabel}>{label}</span>
      </button>
    );
  };

  return (
    <div className={styles.sidebar}>
      <div className={styles.scrollRegion}>
        {/* App logo/title removed per design */}
        {/* User Favorites Section */}
        <div
          className={`${styles.section} ${favoritesFileDropOver ? styles.favoritesDropTarget : ''}`}
          onMouseLeave={() => {
            if (!fileDragActive) return;
            setFavoritesFileDropOver(false);
            onFileDragHoverPath?.(null);
          }}
        >
          <button
            className={styles.sectionTitle}
            aria-expanded={favoritesExpanded}
            aria-controls="favorites-list"
            onClick={() => setFavoritesExpanded((v) => !v)}
            onMouseEnter={() => {
              if (!fileDragActive) return;
              clearFileHover();
              setFavoritesFileDropOver(true);
              onFileDragHoverFavorites?.();
            }}
            onMouseLeave={() => setFavoritesFileDropOver(false)}
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
                    draggable={!fileDragActive && editingFavPath !== fav.path}
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
                        className={`${styles.locationItem} ${isCurrentPath(fav.path) ? styles.locationItemActive : ''}`}
                        aria-label={`Go to ${fav.name}`}
                        aria-current={isCurrentPath(fav.path) ? 'page' : undefined}
                        onClick={() => handleSelect(fav.path)}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleStartRename(fav);
                        }}
                        title="Double-click to rename"
                        data-favorite-index={index}
                        onKeyDown={(event) => handleFavoriteKeyDown(index, event)}
                        onMouseEnter={() => handleFileHoverPath(fav.path)}
                        onMouseLeave={() => handleFileHoverPath(null)}
                      >
                        <span className={styles.locationIcon}>
                          <Icon name="star" />
                        </span>
                        <span className={styles.locationLabel}>{fav.name}</span>
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
                <div
                  className={styles.loadingText}
                  onMouseEnter={() => {
                    if (!fileDragActive) return;
                    setFavoritesFileDropOver(true);
                    onFileDragHoverFavorites?.();
                  }}
                  onMouseLeave={() => setFavoritesFileDropOver(false)}
                >
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
                      className={`${styles.locationItem} ${activeSmartFolderId === sf.id ? styles.locationItemActive : ''}`}
                      aria-label={`Open ${sf.name}`}
                      aria-current={activeSmartFolderId === sf.id ? 'page' : undefined}
                      onClick={() => handleSmartFolderClick(sf)}
                      title={`Search: ${sf.criteria.namePattern || 'all'} in ${sf.criteria.searchPaths?.join(', ') || 'all locations'}`}
                    >
                      <span className={styles.locationIcon}>
                        <Icon name="search" />
                      </span>
                      <span className={styles.locationLabel}>{sf.name}</span>
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
              </>
            ) : locationsError ? (
              <div className={styles.locationsError} role="alert">
                <span>Locations unavailable</span>
                <button type="button" onClick={loadLocations}>
                  Retry
                </button>
              </div>
            ) : (
              <div className={styles.loadingText}>Loading…</div>
            )}
          </div>
        </div>

        <RemoteDrivesSection onSelectLocation={handleSelect} />

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
            ) : locationsError ? (
              <div className={styles.loadingText}>Drives unavailable</div>
            ) : (
              <div className={styles.loadingText}>Loading…</div>
            )}
          </div>
        </div>
      </div>

      <div className={styles.sidebarFooter}>
        {/* Bottom Controls */}
        <div className={styles.bottomControls}>
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
