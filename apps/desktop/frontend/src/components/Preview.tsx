import React, { useEffect, useId, useState } from 'react';
import type { FileEntry } from '../store';
import { useFileStore } from '../store';
import { CustomFieldsEditor } from './CustomFieldsEditor';
import { FinderTags } from './FinderTags';
import styles from './Preview.module.css';
import { formatLocalDateTime } from '../utils/date';
import { areFinderTagsAvailable } from '../services/finderIntegration';

// Interface for the preview file type (from App.tsx FilePreviewer)
type PreviewFile = {
  name: string;
  path: string;
  type: string; // mime type or extension
  url?: string; // local file url or blob
  content?: string; // file content if available (text, markdown, etc)
  externalTool?: string;
  archiveInfo?: {
    format: string;
    entry_count: number;
    total_size: number;
    compressed_size: number;
    entries: Array<{
      path: string;
      size: number;
      compressed_size: number;
      is_dir: boolean;
    }>;
  };
};

type PreviewProps = {
  file: PreviewFile | FileEntry;
  onClose?: () => void; // callback to close the preview
  onUpdate?: (updatedFile: FileEntry) => void; // callback when custom fields are updated
  loading?: boolean;
  onReady?: () => void;
  onContentError?: () => void;
  variant?: 'panel' | 'quicklook';
};

// Type guard to check if file is a PreviewFile
function isPreviewFile(file: PreviewFile | FileEntry): file is PreviewFile {
  return 'type' in file && typeof file.type === 'string';
}

// Type guard to check if file is a FileEntry
function isFileEntry(file: PreviewFile | FileEntry): file is FileEntry {
  return 'id' in file && 'custom' in file;
}

type TabTypes = 'preview' | 'metadata' | 'fields';

// Format file size in human-readable format
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const TEXTUAL_EXTENSIONS = new Set([
  'txt',
  'log',
  'csv',
  'ini',
  'cfg',
  'conf',
  'env',
  'json',
  'json5',
  'jsonc',
  'yaml',
  'yml',
  'md',
  'markdown',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'pyw',
  'cs',
  'csharp',
  'sql',
  'html',
  'htm',
  'xml',
  'svg',
  'css',
  'scss',
  'sass',
  'java',
  'go',
  'rs',
  'c',
  'cpp',
  'cxx',
  'cc',
  'hpp',
  'hh',
  'rb',
  'php',
  'swift',
  'kt',
  'kts',
  'sh',
  'bash',
  'zsh',
  'toml',
  'lock',
]);

const EXECUTABLE_SCRIPT_EXTENSIONS = new Set(['bat', 'cmd', 'ps1', 'psm1']);

// Date formatting moved to utils/date for robustness

export function Preview({
  file,
  onClose,
  onUpdate,
  loading = false,
  onReady,
  onContentError,
  variant = 'panel',
}: PreviewProps) {
  // State for the active tab
  const [activeTab, setActiveTab] = useState<TabTypes>('preview');
  const [finderTagsAvailable, setFinderTagsAvailable] = useState(false);
  const previewExecutableScripts = useFileStore((state) => state.previewExecutableScripts);
  const idPrefix = useId();
  const tabIds = {
    preview: `${idPrefix}-tab-preview`,
    metadata: `${idPrefix}-tab-metadata`,
    fields: `${idPrefix}-tab-fields`,
  } as const;
  const panelIds = {
    preview: `${idPrefix}-panel-preview`,
    metadata: `${idPrefix}-panel-metadata`,
    fields: `${idPrefix}-panel-fields`,
  } as const;
  const showTabs = variant !== 'quicklook';

  // Check if Finder tags are available (macOS only)
  useEffect(() => {
    areFinderTagsAvailable()
      .then(setFinderTagsAvailable)
      .catch(() => setFinderTagsAvailable(false));
  }, []);

  // Get file entry and preview file information (computed before hooks for consistent hook order)
  const fileEntry = file && isFileEntry(file) ? file : null;
  const previewFile = file && isPreviewFile(file) ? file : null;

  // Extract extension for file type detection
  const fileNameParts = file?.path?.split(/[/\\]/) ?? [];
  const fileName = fileNameParts[fileNameParts.length - 1] ?? '';
  const ext = fileName.split('.').pop()?.toLowerCase();

  // Determine file type from extension if not provided
  const fileType =
    previewFile?.type ||
    (ext
      ? ext === 'pdf'
        ? 'application/pdf'
        : ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)
          ? `image/${ext}`
          : ['mp4', 'webm', 'avi', 'mov'].includes(ext)
            ? `video/${ext}`
            : 'application/octet-stream'
      : 'application/octet-stream');

  const textContent =
    previewFile?.content && typeof previewFile.content === 'string' ? previewFile.content : null;

  // Early return AFTER all hooks have been called
  if (!file) return null;

  const renderUnsupportedPreview = (message: string, details: string[] = []) => (
    <div className={styles.previewUnsupported}>
      <div className={styles.unsupportedTitle}>{message}</div>
      {details.map((detail) => (
        <div key={detail} className={styles.fileInfo}>
          {detail}
        </div>
      ))}
    </div>
  );

  // Get file content for preview
  const renderFilePreview = (
    notifyReady?: () => void,
    notifyError?: () => void,
    isLoading?: boolean
  ) => {
    // Image file preview
    if (
      previewFile?.type?.startsWith('image/') ||
      ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext || '')
    ) {
      if (previewFile?.url) {
        return (
          <div className={styles.previewImage}>
            <img src={previewFile.url} alt={fileName} onLoad={notifyReady} onError={notifyError} />
          </div>
        );
      }
      if (isLoading) return null;
      return renderUnsupportedPreview('Cannot preview this image (no preview available).');
    }

    // Video file preview
    if (
      previewFile?.type?.startsWith('video/') ||
      ['mp4', 'webm', 'mov', 'avi'].includes(ext || '')
    ) {
      if (previewFile?.url) {
        return (
          <div className={styles.previewVideo}>
            <video
              src={previewFile.url}
              controls
              onLoadedData={notifyReady}
              onError={notifyError}
            />
          </div>
        );
      }
      if (isLoading) return null;
      return renderUnsupportedPreview('Cannot preview this video (no preview available).');
    }

    // Audio file preview
    if (
      previewFile?.type?.startsWith('audio/') ||
      ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma'].includes(ext || '')
    ) {
      if (previewFile?.url) {
        return (
          <div className={styles.previewAudio}>
            <div className={styles.audioIcon}>
              <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
              </svg>
            </div>
            <audio src={previewFile.url} controls className={styles.audioPlayer} />
            <div className={styles.audioFileName}>{fileName}</div>
          </div>
        );
      }
      if (isLoading) return null;
      return renderUnsupportedPreview('Cannot preview this audio file (no preview available).');
    }

    // PDF file preview
    if (previewFile?.type === 'application/pdf' || ext === 'pdf') {
      if (previewFile?.url) {
        return (
          <div className={styles.previewPdf}>
            <iframe src={previewFile.url} title={fileName} onLoad={notifyReady} />
          </div>
        );
      }
      if (isLoading) return null;
      return renderUnsupportedPreview('Cannot preview this PDF (no preview available).');
    }

    if (previewFile?.type === 'application/x-explorie-archive') {
      const archive = previewFile.archiveInfo;
      if (!archive) {
        if (isLoading) return null;
        return renderUnsupportedPreview(
          'Cannot preview this archive (no archive listing available).'
        );
      }

      return (
        <div className={styles.previewArchive}>
          <div className={styles.archiveSummary}>
            <div>
              <strong>{archive.format.toUpperCase()} archive</strong>
              <span>{archive.entry_count} entries</span>
            </div>
            <div className={styles.archiveStats}>
              <span>{formatFileSize(archive.total_size)} unpacked</span>
              <span>{formatFileSize(archive.compressed_size)} compressed</span>
            </div>
          </div>
          <div className={styles.archiveEntries} role="list" aria-label="Archive contents">
            {archive.entries.slice(0, 200).map((entry) => (
              <div key={entry.path} className={styles.archiveEntry} role="listitem">
                <span className={styles.archiveEntryKind}>{entry.is_dir ? 'DIR' : 'FILE'}</span>
                <span className={styles.archiveEntryPath}>{entry.path}</span>
                <span className={styles.archiveEntrySize}>
                  {entry.is_dir ? '' : formatFileSize(entry.size)}
                </span>
              </div>
            ))}
          </div>
          {archive.entries.length > 200 && (
            <div className={styles.archiveMore}>
              Showing first 200 of {archive.entry_count} entries
            </div>
          )}
        </div>
      );
    }

    // Markdown preview is intentionally plain text: local files are untrusted input.
    if (['md', 'markdown'].includes(ext || '')) {
      const md = previewFile?.content || '';
      return (
        <div className={styles.previewText}>
          <pre>{md || 'Empty markdown file'}</pre>
        </div>
      );
    }

    const extKey = ext ?? '';

    if (!previewExecutableScripts && extKey && EXECUTABLE_SCRIPT_EXTENSIONS.has(extKey)) {
      if (isLoading) return null;
      return renderUnsupportedPreview('Script previews are disabled for executable files.', [
        `${fileName} (${fileType || extKey || 'unknown'})`,
        'Enable this in Settings > General.',
      ]);
    }

    if (
      textContent &&
      (previewFile?.type?.startsWith('text/') ||
        (extKey && TEXTUAL_EXTENSIONS.has(extKey)) ||
        (previewExecutableScripts && EXECUTABLE_SCRIPT_EXTENSIONS.has(extKey)))
    ) {
      return (
        <div className={styles.previewCode}>
          <pre>
            <code>{textContent}</code>
          </pre>
        </div>
      );
    }

    // For any other file type: try to show as text if content is available
    if (
      previewFile?.content &&
      typeof previewFile.content === 'string' &&
      (previewExecutableScripts || !EXECUTABLE_SCRIPT_EXTENSIONS.has(extKey))
    ) {
      return (
        <div className={styles.previewText}>
          <pre>{previewFile.content}</pre>
        </div>
      );
    }

    // Default: no preview available
    if (isLoading) return null;

    return renderUnsupportedPreview('No preview available for this file type.', [
      `${fileName} (${fileType || ext || 'unknown'})`,
    ]);
  };

  // Render basic file metadata
  const renderFileMetadata = () => {
    if (!fileEntry) return null;

    return (
      <div className={styles.fileMetadata}>
        <div className={styles.metadataLabel}>Name:</div>
        <div className={styles.metadataValue}>{fileName}</div>

        <div className={styles.metadataLabel}>Path:</div>
        <div className={styles.metadataValue}>{file.path}</div>

        <div className={styles.metadataLabel}>Size:</div>
        <div className={styles.metadataValue}>{formatFileSize(fileEntry.size)}</div>

        <div className={styles.metadataLabel}>Modified:</div>
        <div className={styles.metadataValue}>{formatLocalDateTime(fileEntry.modified)}</div>

        <div className={styles.metadataLabel}>Type:</div>
        <div className={styles.metadataValue}>{fileType || ext || 'Unknown'}</div>

        {/* Finder Tags (macOS only) */}
        {finderTagsAvailable && (
          <>
            <div className={styles.metadataLabel}>Tags:</div>
            <div className={styles.metadataValue}>
              <FinderTags path={file.path} editable />
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div
      className={`${styles.previewContainer} ${
        variant === 'quicklook' ? styles.previewContainerQuickLook : ''
      }`}
    >
      {/* Close button */}
      {onClose && (
        <button
          onClick={onClose}
          className={styles.closeButton}
          aria-label="Close preview"
          title="Close preview"
        >
          &times;
        </button>
      )}

      {/* Tabs navigation */}
      {showTabs && (
        <div className={styles.tabsContainer} role="tablist" aria-label="Preview tabs">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'preview'}
            id={tabIds.preview}
            aria-controls={panelIds.preview}
            tabIndex={activeTab === 'preview' ? 0 : -1}
            className={`${styles.tab} ${activeTab === 'preview' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('preview')}
          >
            Preview
          </button>

          {fileEntry && (
            <>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'metadata'}
                id={tabIds.metadata}
                aria-controls={panelIds.metadata}
                tabIndex={activeTab === 'metadata' ? 0 : -1}
                className={`${styles.tab} ${activeTab === 'metadata' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('metadata')}
              >
                Metadata
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'fields'}
                id={tabIds.fields}
                aria-controls={panelIds.fields}
                tabIndex={activeTab === 'fields' ? 0 : -1}
                className={`${styles.tab} ${activeTab === 'fields' ? styles.tabActive : ''}`}
                onClick={() => setActiveTab('fields')}
              >
                Custom Fields
              </button>
            </>
          )}
        </div>
      )}

      {/* Tab content */}
      {activeTab === 'preview' && (
        <div
          className={`${styles.previewContent} ${
            variant === 'quicklook' ? styles.previewContentQuickLook : ''
          }`}
          role={showTabs ? 'tabpanel' : undefined}
          id={showTabs ? panelIds.preview : undefined}
          aria-labelledby={showTabs ? tabIds.preview : undefined}
        >
          {renderFilePreview(onReady, onContentError, loading)}
          {!loading && previewFile?.externalTool && (
            <div className={styles.previewToolNote}>
              Preview generated by {previewFile.externalTool}
            </div>
          )}
          {loading && (
            <div className={styles.loadingState} role="status" aria-live="polite">
              <span className={styles.loadingSpinner} aria-hidden />
              <span>Loading preview...</span>
            </div>
          )}
        </div>
      )}

      {activeTab === 'metadata' && fileEntry && (
        <div
          className={styles.metadataSection}
          role="tabpanel"
          id={panelIds.metadata}
          aria-labelledby={tabIds.metadata}
        >
          {renderFileMetadata()}
        </div>
      )}

      {activeTab === 'fields' && fileEntry && (
        <div
          className={styles.metadataSection}
          role="tabpanel"
          id={panelIds.fields}
          aria-labelledby={tabIds.fields}
        >
          <CustomFieldsEditor file={fileEntry} onUpdate={onUpdate} />
        </div>
      )}
    </div>
  );
}
