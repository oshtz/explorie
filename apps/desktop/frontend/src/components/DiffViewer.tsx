import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { Change } from 'diff';
import { diffLines, diffChars, diffWords } from 'diff';
import { readDir, readFile, readTextFile, stat } from '@tauri-apps/plugin-fs';
import { Icon } from './Icon';
import { resolveHighlightLanguage, highlightCode } from '../utils/highlight';
import { formatErrorMessage } from '../utils/errorMessages';
import styles from './DiffViewer.module.css';

export interface DiffFile {
  path: string;
  name: string;
  isDir?: boolean;
}

// Folder comparison result
export interface FolderDiffEntry {
  name: string;
  leftPath?: string;
  rightPath?: string;
  status: 'same' | 'different' | 'left-only' | 'right-only';
  isDir: boolean;
  leftSize?: number;
  rightSize?: number;
  leftModified?: number;
  rightModified?: number;
}

interface DiffViewerProps {
  open: boolean;
  onClose: () => void;
  leftFile: DiffFile | null;
  rightFile: DiffFile | null;
  /** Called when user wants to select a file for comparison */
  onSelectFile?: (side: 'left' | 'right') => void;
  /** If true, compare as folders instead of files */
  compareMode?: 'files' | 'folders';
}

type DiffMode = 'lines' | 'words' | 'chars';
type ViewMode = 'side-by-side' | 'inline';

// Helper to get file extension from path
function getExtension(path: string): string | null {
  const parts = path.split(/[/\\]/);
  const filename = parts[parts.length - 1];
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex > 0) {
    return filename.slice(dotIndex + 1).toLowerCase();
  }
  return null;
}

// Helper to format file size
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Check if file is an image
function isImageFile(path: string): boolean {
  const ext = getExtension(path);
  if (!ext) return false;
  return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext);
}

interface DiffLine {
  left: { lineNum: number; content: string; type: 'unchanged' | 'removed' | 'modified' } | null;
  right: { lineNum: number; content: string; type: 'unchanged' | 'added' | 'modified' } | null;
}

interface InlineLine {
  lineNum: number;
  content: string;
  type: 'unchanged' | 'added' | 'removed';
  sourceLineNum?: number; // Original line number from left or right file
}

/**
 * DiffViewer - Compare two text files side-by-side or inline
 */
export function DiffViewer({
  open,
  onClose,
  leftFile,
  rightFile,
  onSelectFile,
  compareMode = 'files',
}: DiffViewerProps) {
  const [leftContent, setLeftContent] = useState<string>('');
  const [rightContent, setRightContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>('lines');
  const [viewMode, setViewMode] = useState<ViewMode>('side-by-side');
  const [syntaxHighlight, setSyntaxHighlight] = useState(true);
  const [isClosing, setIsClosing] = useState(false);
  const [currentDiffIndex, setCurrentDiffIndex] = useState(0);

  // Folder comparison state
  const [folderDiff, setFolderDiff] = useState<FolderDiffEntry[]>([]);
  const [isFolderMode, setIsFolderMode] = useState(compareMode === 'folders');

  // Image comparison state
  const [isImageMode, setIsImageMode] = useState(false);
  const [leftImageUrl, setLeftImageUrl] = useState<string | null>(null);
  const [rightImageUrl, setRightImageUrl] = useState<string | null>(null);
  const [imageViewMode, setImageViewMode] = useState<'side-by-side' | 'overlay' | 'slider'>(
    'side-by-side'
  );
  const [sliderPosition, setSliderPosition] = useState(50);
  const [overlayOpacity, setOverlayOpacity] = useState(0.5);

  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const inlinePanelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Load file contents or compare folders
  useEffect(() => {
    if (!open) return;

    // Check if we should be in folder mode
    const shouldBeFolderMode =
      compareMode === 'folders' || Boolean(leftFile?.isDir && rightFile?.isDir);
    setIsFolderMode(shouldBeFolderMode);

    if (shouldBeFolderMode) {
      // Folder comparison mode
      const compareFolders = async () => {
        setLoading(true);
        setError(null);
        setFolderDiff([]);

        try {
          const leftEntries = new Map<
            string,
            { path: string; size: number; modified: number; isDir: boolean }
          >();
          const rightEntries = new Map<
            string,
            { path: string; size: number; modified: number; isDir: boolean }
          >();

          if (leftFile) {
            const entries = await readDir(leftFile.path);
            for (const entry of entries) {
              const fullPath = `${leftFile.path}/${entry.name}`;
              try {
                const info = await stat(fullPath);
                leftEntries.set(entry.name, {
                  path: fullPath,
                  size: info.size,
                  modified: info.mtime ? new Date(info.mtime).getTime() : 0,
                  isDir: info.isDirectory,
                });
              } catch {
                leftEntries.set(entry.name, {
                  path: fullPath,
                  size: 0,
                  modified: 0,
                  isDir: entry.isDirectory || false,
                });
              }
            }
          }

          if (rightFile) {
            const entries = await readDir(rightFile.path);
            for (const entry of entries) {
              const fullPath = `${rightFile.path}/${entry.name}`;
              try {
                const info = await stat(fullPath);
                rightEntries.set(entry.name, {
                  path: fullPath,
                  size: info.size,
                  modified: info.mtime ? new Date(info.mtime).getTime() : 0,
                  isDir: info.isDirectory,
                });
              } catch {
                rightEntries.set(entry.name, {
                  path: fullPath,
                  size: 0,
                  modified: 0,
                  isDir: entry.isDirectory || false,
                });
              }
            }
          }

          // Build diff list
          const allNames = new Set([...leftEntries.keys(), ...rightEntries.keys()]);
          const diffList: FolderDiffEntry[] = [];

          for (const name of allNames) {
            const left = leftEntries.get(name);
            const right = rightEntries.get(name);

            if (left && right) {
              // Both exist - check if they're the same
              const isSame = left.size === right.size && left.isDir === right.isDir;
              diffList.push({
                name,
                leftPath: left.path,
                rightPath: right.path,
                status: isSame ? 'same' : 'different',
                isDir: left.isDir || right.isDir,
                leftSize: left.size,
                rightSize: right.size,
                leftModified: left.modified,
                rightModified: right.modified,
              });
            } else if (left) {
              // Only in left
              diffList.push({
                name,
                leftPath: left.path,
                status: 'left-only',
                isDir: left.isDir,
                leftSize: left.size,
                leftModified: left.modified,
              });
            } else if (right) {
              // Only in right
              diffList.push({
                name,
                rightPath: right.path,
                status: 'right-only',
                isDir: right.isDir,
                rightSize: right.size,
                rightModified: right.modified,
              });
            }
          }

          // Sort: directories first, then by name
          diffList.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });

          setFolderDiff(diffList);
        } catch (e) {
          setError(`Failed to compare folders: ${formatErrorMessage(e)}`);
        } finally {
          setLoading(false);
        }
      };

      compareFolders();
    } else {
      // Check if both files are images
      const bothImages = Boolean(
        leftFile && rightFile && isImageFile(leftFile.path) && isImageFile(rightFile.path)
      );
      setIsImageMode(bothImages);

      if (bothImages) {
        // Image comparison mode
        let nextLeftImageUrl: string | null = null;
        let nextRightImageUrl: string | null = null;
        const loadImages = async () => {
          setLoading(true);
          setError(null);

          try {
            // Convert file content to blob URLs
            if (leftFile) {
              const content = await readFile(leftFile.path);
              // Use slice() to create a new Uint8Array with a proper ArrayBuffer for Blob compatibility
              const blob = new Blob([content.slice()]);
              nextLeftImageUrl = URL.createObjectURL(blob);
              setLeftImageUrl(nextLeftImageUrl);
            }

            if (rightFile) {
              const content = await readFile(rightFile.path);
              const blob = new Blob([content.slice()]);
              nextRightImageUrl = URL.createObjectURL(blob);
              setRightImageUrl(nextRightImageUrl);
            }
          } catch (e) {
            setError(`Failed to load images: ${formatErrorMessage(e)}`);
          } finally {
            setLoading(false);
          }
        };

        loadImages();

        // Cleanup blob URLs on unmount
        return () => {
          if (nextLeftImageUrl) URL.revokeObjectURL(nextLeftImageUrl);
          if (nextRightImageUrl) URL.revokeObjectURL(nextRightImageUrl);
        };
      } else {
        // Text file comparison mode
        const loadFiles = async () => {
          setLoading(true);
          setError(null);

          try {
            if (leftFile) {
              const content = await readTextFile(leftFile.path);
              setLeftContent(content);
            } else {
              setLeftContent('');
            }

            if (rightFile) {
              const content = await readTextFile(rightFile.path);
              setRightContent(content);
            } else {
              setRightContent('');
            }
          } catch (e) {
            setError(`Failed to load files: ${formatErrorMessage(e)}`);
          } finally {
            setLoading(false);
          }
        };

        loadFiles();
      }
    }
  }, [open, leftFile, rightFile, compareMode]);

  // Compute diff
  const {
    diffLines: sideBySideLines,
    inlineLines,
    diffCount,
  } = useMemo(() => {
    if (!leftContent && !rightContent) {
      return { diffLines: [], inlineLines: [], diffCount: 0 };
    }

    let rawChanges: Change[];
    switch (diffMode) {
      case 'chars':
        rawChanges = diffChars(leftContent, rightContent);
        break;
      case 'words':
        rawChanges = diffWords(leftContent, rightContent);
        break;
      case 'lines':
      default:
        rawChanges = diffLines(leftContent, rightContent);
        break;
    }

    // Build side-by-side diff lines
    const sideBySide: DiffLine[] = [];
    const inline: InlineLine[] = [];
    let leftLineNum = 1;
    let rightLineNum = 1;
    let diffCount = 0;

    for (const change of rawChanges) {
      const lines = change.value.split('\n');
      // Remove last empty line if value ends with newline
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }

      if (change.added) {
        diffCount++;
        for (const line of lines) {
          sideBySide.push({
            left: null,
            right: { lineNum: rightLineNum++, content: line, type: 'added' },
          });
          inline.push({
            lineNum: rightLineNum - 1,
            content: line,
            type: 'added',
          });
        }
      } else if (change.removed) {
        diffCount++;
        for (const line of lines) {
          sideBySide.push({
            left: { lineNum: leftLineNum++, content: line, type: 'removed' },
            right: null,
          });
          inline.push({
            lineNum: leftLineNum - 1,
            content: line,
            type: 'removed',
          });
        }
      } else {
        for (const line of lines) {
          sideBySide.push({
            left: { lineNum: leftLineNum++, content: line, type: 'unchanged' },
            right: { lineNum: rightLineNum++, content: line, type: 'unchanged' },
          });
          inline.push({
            lineNum: leftLineNum - 1,
            content: line,
            type: 'unchanged',
          });
        }
      }
    }

    return { diffLines: sideBySide, inlineLines: inline, diffCount };
  }, [leftContent, rightContent, diffMode]);

  // Determine the language for syntax highlighting based on file extensions
  const highlightLanguage = useMemo(() => {
    if (!syntaxHighlight) return null;

    // Try to detect from left file first, then right file
    const leftExt = leftFile ? getExtension(leftFile.path) : null;
    const rightExt = rightFile ? getExtension(rightFile.path) : null;

    const ext = leftExt || rightExt;
    if (ext) {
      return resolveHighlightLanguage({ ext });
    }
    return null;
  }, [leftFile, rightFile, syntaxHighlight]);

  // Helper to highlight a line's content
  const highlightLine = useCallback(
    (content: string): string => {
      if (!syntaxHighlight || !highlightLanguage) return content;
      try {
        return highlightCode(content, highlightLanguage);
      } catch {
        return content;
      }
    },
    [syntaxHighlight, highlightLanguage]
  );

  // Find diff positions for navigation
  const diffPositions = useMemo(() => {
    const positions: number[] = [];
    sideBySideLines.forEach((line, index) => {
      if (
        (line.left && line.left.type !== 'unchanged') ||
        (line.right && line.right.type !== 'unchanged')
      ) {
        // Only add if this is the start of a diff block
        if (positions.length === 0 || positions[positions.length - 1] !== index - 1) {
          positions.push(index);
        }
      }
    });
    return positions;
  }, [sideBySideLines]);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 150);
  }, [onClose]);

  // Navigate to next/previous diff
  const navigateToDiff = useCallback(
    (direction: 'next' | 'prev') => {
      if (diffPositions.length === 0) return;

      let newIndex: number;
      if (direction === 'next') {
        newIndex = (currentDiffIndex + 1) % diffPositions.length;
      } else {
        newIndex = (currentDiffIndex - 1 + diffPositions.length) % diffPositions.length;
      }

      setCurrentDiffIndex(newIndex);

      // Scroll to the diff position
      const lineIndex = diffPositions[newIndex];
      const lineHeight = 22; // Approximate line height
      const scrollTop = lineIndex * lineHeight;

      if (viewMode === 'side-by-side') {
        leftPanelRef.current?.scrollTo({ top: scrollTop, behavior: 'smooth' });
        rightPanelRef.current?.scrollTo({ top: scrollTop, behavior: 'smooth' });
      } else {
        inlinePanelRef.current?.scrollTo({ top: scrollTop, behavior: 'smooth' });
      }
    },
    [currentDiffIndex, diffPositions, viewMode]
  );

  // Sync scroll between left and right panels
  const handleLeftScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (rightPanelRef.current) {
      rightPanelRef.current.scrollTop = e.currentTarget.scrollTop;
    }
  }, []);

  const handleRightScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (leftPanelRef.current) {
      leftPanelRef.current.scrollTop = e.currentTarget.scrollTop;
    }
  }, []);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      } else if (e.key === 'ArrowDown' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        navigateToDiff('next');
      } else if (e.key === 'ArrowUp' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        navigateToDiff('prev');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, handleClose, navigateToDiff]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === backdropRef.current) {
        handleClose();
      }
    },
    [handleClose]
  );

  if (!open) return null;

  const hasFiles = leftFile && rightFile;
  const hasDiffs = diffCount > 0;

  return (
    <div
      ref={backdropRef}
      className={`${styles.backdrop} ${isClosing ? styles.closing : ''}`}
      onClick={handleBackdropClick}
    >
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.title}>
            <Icon name="git-compare" />
            Compare {isFolderMode ? 'Folders' : isImageMode ? 'Images' : 'Files'}
          </h2>

          <div className={styles.controls}>
            {/* View mode toggle */}
            <div className={styles.toggleGroup}>
              <button
                className={`${styles.toggleButton} ${viewMode === 'side-by-side' ? styles.active : ''}`}
                onClick={() => setViewMode('side-by-side')}
                title="Side by side view"
              >
                <Icon name="columns" />
              </button>
              <button
                className={`${styles.toggleButton} ${viewMode === 'inline' ? styles.active : ''}`}
                onClick={() => setViewMode('inline')}
                title="Inline view"
              >
                <Icon name="rows" />
              </button>
            </div>

            {/* Diff mode select */}
            <select
              className={styles.select}
              value={diffMode}
              onChange={(e) => setDiffMode(e.target.value as DiffMode)}
            >
              <option value="lines">Line diff</option>
              <option value="words">Word diff</option>
              <option value="chars">Character diff</option>
            </select>

            {/* Syntax highlighting toggle (only for text files) */}
            {!isImageMode && !isFolderMode && (
              <button
                className={`${styles.toggleButton} ${syntaxHighlight ? styles.active : ''}`}
                onClick={() => setSyntaxHighlight(!syntaxHighlight)}
                title={
                  syntaxHighlight ? 'Disable syntax highlighting' : 'Enable syntax highlighting'
                }
                style={{ width: 'auto', padding: '0 8px' }}
              >
                <Icon name="code" />
              </button>
            )}

            {/* Image view mode toggle (only for images) */}
            {isImageMode && (
              <div className={styles.toggleGroup}>
                <button
                  className={`${styles.toggleButton} ${imageViewMode === 'side-by-side' ? styles.active : ''}`}
                  onClick={() => setImageViewMode('side-by-side')}
                  title="Side by side"
                >
                  <Icon name="columns" />
                </button>
                <button
                  className={`${styles.toggleButton} ${imageViewMode === 'overlay' ? styles.active : ''}`}
                  onClick={() => setImageViewMode('overlay')}
                  title="Overlay"
                >
                  <Icon name="copy" />
                </button>
                <button
                  className={`${styles.toggleButton} ${imageViewMode === 'slider' ? styles.active : ''}`}
                  onClick={() => setImageViewMode('slider')}
                  title="Slider"
                >
                  <Icon name="chevrons-horizontal" />
                </button>
              </div>
            )}

            {/* Diff navigation */}
            {hasDiffs && (
              <div className={styles.navButtons}>
                <button
                  className={styles.navButton}
                  onClick={() => navigateToDiff('prev')}
                  title="Previous change (Ctrl+Up)"
                >
                  <Icon name="chevron-up" />
                </button>
                <span className={styles.diffCount}>
                  {currentDiffIndex + 1} / {diffPositions.length}
                </span>
                <button
                  className={styles.navButton}
                  onClick={() => navigateToDiff('next')}
                  title="Next change (Ctrl+Down)"
                >
                  <Icon name="chevron-down" />
                </button>
              </div>
            )}
          </div>

          <button className={styles.closeButton} onClick={handleClose} title="Close (Escape)">
            <Icon name="x" />
          </button>
        </div>

        {/* File headers */}
        <div className={styles.fileHeaders}>
          <div className={styles.fileHeader}>
            {leftFile ? (
              <>
                <Icon name="file-minus" />
                <span className={styles.fileName}>{leftFile.name}</span>
                <span className={styles.filePath}>{leftFile.path}</span>
              </>
            ) : (
              <button className={styles.selectFileButton} onClick={() => onSelectFile?.('left')}>
                Select left file...
              </button>
            )}
          </div>
          <div className={styles.fileHeader}>
            {rightFile ? (
              <>
                <Icon name="file-plus" />
                <span className={styles.fileName}>{rightFile.name}</span>
                <span className={styles.filePath}>{rightFile.path}</span>
              </>
            ) : (
              <button className={styles.selectFileButton} onClick={() => onSelectFile?.('right')}>
                Select right file...
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className={styles.content}>
          {loading ? (
            <div className={styles.loading}>
              <Icon name="loader" />
              Loading files...
            </div>
          ) : error ? (
            <div className={styles.error}>
              <Icon name="warning-box" />
              {error}
            </div>
          ) : !hasFiles ? (
            <div className={styles.placeholder}>
              <Icon name="git-compare" />
              <p>
                Select two {isFolderMode ? 'folders' : isImageMode ? 'images' : 'files'} to compare
              </p>
            </div>
          ) : isImageMode ? (
            /* Image comparison view */
            <div className={styles.imageCompareContainer}>
              {imageViewMode === 'side-by-side' && (
                <div className={styles.imageSideBySide}>
                  <div className={styles.imagePanel}>
                    {leftImageUrl && (
                      <img src={leftImageUrl} alt="Left" className={styles.compareImage} />
                    )}
                  </div>
                  <div className={styles.imagePanel}>
                    {rightImageUrl && (
                      <img src={rightImageUrl} alt="Right" className={styles.compareImage} />
                    )}
                  </div>
                </div>
              )}
              {imageViewMode === 'overlay' && (
                <div className={styles.imageOverlay}>
                  {leftImageUrl && (
                    <img src={leftImageUrl} alt="Left" className={styles.compareImage} />
                  )}
                  {rightImageUrl && (
                    <img
                      src={rightImageUrl}
                      alt="Right"
                      className={`${styles.compareImage} ${styles.overlayImage}`}
                      style={{ opacity: overlayOpacity }}
                    />
                  )}
                  <div className={styles.overlayControls}>
                    <label>Opacity:</label>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={overlayOpacity}
                      onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
                    />
                  </div>
                </div>
              )}
              {imageViewMode === 'slider' && (
                <div className={styles.imageSlider}>
                  <div className={styles.sliderContainer}>
                    {leftImageUrl && (
                      <img src={leftImageUrl} alt="Left" className={styles.compareImage} />
                    )}
                    {rightImageUrl && (
                      <div
                        className={styles.sliderClip}
                        style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}
                      >
                        <img src={rightImageUrl} alt="Right" className={styles.compareImage} />
                      </div>
                    )}
                    <div className={styles.sliderHandle} style={{ left: `${sliderPosition}%` }} />
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={sliderPosition}
                    onChange={(e) => setSliderPosition(parseInt(e.target.value))}
                    className={styles.sliderInput}
                  />
                </div>
              )}
            </div>
          ) : isFolderMode ? (
            /* Folder comparison view */
            <div className={styles.folderDiffPanel}>
              <div className={styles.folderDiffHeader}>
                <div className={styles.folderDiffCol}>Status</div>
                <div className={styles.folderDiffCol}>Name</div>
                <div className={styles.folderDiffCol}>Left Size</div>
                <div className={styles.folderDiffCol}>Right Size</div>
              </div>
              {folderDiff.length === 0 ? (
                <div className={styles.emptyDiff}>Folders are identical</div>
              ) : (
                folderDiff.map((entry) => (
                  <div
                    key={
                      entry.leftPath ??
                      entry.rightPath ??
                      `${entry.status}:${entry.name}:${entry.leftSize ?? ''}:${entry.rightSize ?? ''}`
                    }
                    className={`${styles.folderDiffRow} ${styles[`folderDiff${entry.status.replace('-', '')}`]}`}
                  >
                    <div className={styles.folderDiffCol}>
                      <span className={styles.statusIcon}>
                        {entry.status === 'same' && <Icon name="check" />}
                        {entry.status === 'different' && <Icon name="alert" />}
                        {entry.status === 'left-only' && <Icon name="arrow-left" />}
                        {entry.status === 'right-only' && <Icon name="arrow-right" />}
                      </span>
                    </div>
                    <div className={styles.folderDiffCol}>
                      <Icon name={entry.isDir ? 'folder' : 'file'} />
                      {entry.name}
                    </div>
                    <div className={styles.folderDiffCol}>
                      {entry.leftSize !== undefined ? formatFileSize(entry.leftSize) : '—'}
                    </div>
                    <div className={styles.folderDiffCol}>
                      {entry.rightSize !== undefined ? formatFileSize(entry.rightSize) : '—'}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : viewMode === 'side-by-side' ? (
            <div className={styles.sideBySide}>
              {/* Left panel */}
              <div ref={leftPanelRef} className={styles.panel} onScroll={handleLeftScroll}>
                {sideBySideLines.map((line) => (
                  <div
                    key={`left-${line.left?.lineNum ?? 'blank'}-${line.right?.lineNum ?? 'blank'}-${line.left?.type ?? 'empty'}-${line.left?.content ?? ''}`}
                    className={`${styles.line} ${
                      line.left?.type === 'removed' ? styles.removed : ''
                    } ${line.left?.type === 'unchanged' ? '' : styles.empty}`}
                  >
                    <span className={styles.lineNumber}>{line.left?.lineNum ?? ''}</span>
                    <span
                      className={styles.lineContent}
                      dangerouslySetInnerHTML={
                        syntaxHighlight && line.left?.content
                          ? { __html: highlightLine(line.left.content) }
                          : undefined
                      }
                    >
                      {!syntaxHighlight || !line.left?.content
                        ? (line.left?.content ?? '')
                        : undefined}
                    </span>
                  </div>
                ))}
              </div>

              {/* Right panel */}
              <div ref={rightPanelRef} className={styles.panel} onScroll={handleRightScroll}>
                {sideBySideLines.map((line) => (
                  <div
                    key={`right-${line.left?.lineNum ?? 'blank'}-${line.right?.lineNum ?? 'blank'}-${line.right?.type ?? 'empty'}-${line.right?.content ?? ''}`}
                    className={`${styles.line} ${
                      line.right?.type === 'added' ? styles.added : ''
                    } ${line.right?.type === 'unchanged' ? '' : styles.empty}`}
                  >
                    <span className={styles.lineNumber}>{line.right?.lineNum ?? ''}</span>
                    <span
                      className={styles.lineContent}
                      dangerouslySetInnerHTML={
                        syntaxHighlight && line.right?.content
                          ? { __html: highlightLine(line.right.content) }
                          : undefined
                      }
                    >
                      {!syntaxHighlight || !line.right?.content
                        ? (line.right?.content ?? '')
                        : undefined}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* Inline view */
            <div ref={inlinePanelRef} className={styles.inlinePanel}>
              {inlineLines.map((line) => (
                <div
                  key={`inline-${line.type}-${line.lineNum}-${line.sourceLineNum ?? 'derived'}-${line.content}`}
                  className={`${styles.line} ${
                    line.type === 'added'
                      ? styles.added
                      : line.type === 'removed'
                        ? styles.removed
                        : ''
                  }`}
                >
                  <span className={styles.lineNumber}>{line.lineNum}</span>
                  <span className={styles.linePrefix}>
                    {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                  </span>
                  <span
                    className={styles.lineContent}
                    dangerouslySetInnerHTML={
                      syntaxHighlight && line.content
                        ? { __html: highlightLine(line.content) }
                        : undefined
                    }
                  >
                    {!syntaxHighlight || !line.content ? line.content : undefined}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <div className={styles.stats}>
            {hasFiles && !loading && !isFolderMode && (
              <>
                <span className={styles.statItem}>
                  <span className={styles.statRemoved}>
                    {sideBySideLines.filter((l) => l.left?.type === 'removed').length}
                  </span>{' '}
                  removed
                </span>
                <span className={styles.statItem}>
                  <span className={styles.statAdded}>
                    {sideBySideLines.filter((l) => l.right?.type === 'added').length}
                  </span>{' '}
                  added
                </span>
                <span className={styles.statItem}>
                  {sideBySideLines.filter((l) => l.left?.type === 'unchanged').length} unchanged
                </span>
              </>
            )}
            {hasFiles && !loading && isFolderMode && (
              <>
                <span className={styles.statItem}>
                  <span className={styles.statRemoved}>
                    {folderDiff.filter((e) => e.status === 'left-only').length}
                  </span>{' '}
                  left only
                </span>
                <span className={styles.statItem}>
                  <span className={styles.statAdded}>
                    {folderDiff.filter((e) => e.status === 'right-only').length}
                  </span>{' '}
                  right only
                </span>
                <span className={styles.statItem}>
                  {folderDiff.filter((e) => e.status === 'different').length} different
                </span>
                <span className={styles.statItem}>
                  {folderDiff.filter((e) => e.status === 'same').length} identical
                </span>
              </>
            )}
          </div>
          <div className={styles.shortcuts}>
            {!isFolderMode && (
              <>
                <kbd>Ctrl+Up/Down</kbd> Navigate changes
              </>
            )}
            <kbd>Esc</kbd> Close
          </div>
        </div>
      </div>
    </div>
  );
}

export default DiffViewer;
