import React from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { readFile as readBinaryFile } from '@tauri-apps/plugin-fs';
import type { FileEntry } from '../store';
import { useFileStore } from '../store';
import { Preview } from './Preview';
import { readTextFile } from '../utils/fs';
import { getCachedPreview, setCachedPreview } from '../utils/previewCache';
import { formatErrorMessage } from '../utils/errorMessages';
import { normalizePath } from '../utils/path';
import { getPreviewProviderKind } from '../utils/previewProviders';

// Helper: convert Uint8Array to base64
function uint8ToBase64(u8: Uint8Array) {
  let binary = '';
  for (let i = 0; i < u8.length; i++) {
    binary += String.fromCharCode(u8[i]);
  }
  return window.btoa(binary);
}

const BASE_TEXT_PREVIEW_EXTENSIONS = new Set([
  'txt',
  'log',
  'json',
  'js',
  'ts',
  'tsx',
  'css',
  'html',
  'md',
  'markdown',
  'csv',
  'env',
]);

const EXECUTABLE_SCRIPT_PREVIEW_EXTENSIONS = new Set(['ps1', 'psm1', 'bat', 'cmd']);

interface FilePreviewerProps {
  file: FileEntry;
  onClose?: () => void;
  variant?: 'panel' | 'quicklook';
}

type ArchivePreviewEntry = {
  path: string;
  size: number;
  compressed_size: number;
  is_dir: boolean;
};

type ArchivePreviewInfo = {
  format: string;
  entry_count: number;
  total_size: number;
  compressed_size: number;
  entries: ArchivePreviewEntry[];
};

type PreviewArtifact = {
  kind: string;
  path: string;
  mime_type: string;
  tool: string;
};

/**
 * FilePreviewer: handles loading and previewing files
 * Accepts an onClose prop to allow closing the preview panel.
 */
export function FilePreviewer({ file, onClose, variant = 'panel' }: FilePreviewerProps) {
  const setFiles = useFileStore((state) => state.setFiles);
  const previewExecutableScripts = useFileStore((state) => state.previewExecutableScripts);

  const [dataUrl, setDataUrl] = React.useState<string | undefined>(undefined);
  const [textContent, setTextContent] = React.useState<string | undefined>(undefined);
  const [fullText, setFullText] = React.useState<string | undefined>(undefined);
  const [isTruncated, setIsTruncated] = React.useState<boolean>(false);
  const [fileType, setFileType] = React.useState<string>('');
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [currentFile, setCurrentFile] = React.useState<FileEntry>(file);
  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [archiveInfo, setArchiveInfo] = React.useState<ArchivePreviewInfo | undefined>(undefined);
  const [externalTool, setExternalTool] = React.useState<string | undefined>(undefined);
  const fallbackHandlerRef = React.useRef<(() => Promise<void>) | null>(null);
  const fallbackInFlightRef = React.useRef(false);

  const handlePreviewReady = React.useCallback(() => {
    fallbackHandlerRef.current = null;
    fallbackInFlightRef.current = false;
    setIsLoading(false);
  }, []);

  const handlePreviewError = React.useCallback(() => {
    const runner = fallbackHandlerRef.current;
    if (runner) {
      void runner();
      return;
    }
    if (fallbackInFlightRef.current) {
      return;
    }
    fallbackHandlerRef.current = null;
    fallbackInFlightRef.current = false;
    setError('Failed to load image preview.');
    setIsLoading(false);
  }, []);

  const toPreviewSrc = React.useCallback(
    (inputPath: string | undefined | null): string | undefined => {
      if (!inputPath) return undefined;
      const normalized = normalizePath(inputPath);
      try {
        return convertFileSrc(normalized, 'asset');
      } catch {
        if (/^[a-zA-Z]+:\/\//.test(normalized)) return normalized;
        if (/^[a-zA-Z]:/.test(normalized)) return `file:///${normalized}`;
        return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
      }
    },
    []
  );

  React.useEffect(() => {
    setCurrentFile(file);

    const ext = file.path.split('.').pop()?.toLowerCase() || '';
    const providerKind = getPreviewProviderKind(file.path);
    let cancelled = false;
    setIsLoading(true);
    fallbackHandlerRef.current = null;
    fallbackInFlightRef.current = false;

    const isTextExtension = (extension: string): boolean => {
      if (!extension) return false;
      if (BASE_TEXT_PREVIEW_EXTENSIONS.has(extension)) return true;
      if (providerKind === 'text') return true;
      if (previewExecutableScripts && EXECUTABLE_SCRIPT_PREVIEW_EXTENSIONS.has(extension))
        return true;
      return false;
    };

    // Helper: guess mime type from extension
    function guessType(ext: string): string {
      if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext))
        return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      if (providerKind === 'browser-video') return `video/${ext === 'm4v' ? 'mp4' : ext}`;
      if (['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma'].includes(ext))
        return `audio/${ext === 'mp3' ? 'mpeg' : ext}`;
      if (ext === 'pdf') return 'application/pdf';
      if (['md', 'markdown'].includes(ext)) return 'text/markdown';
      if (isTextExtension(ext)) return 'text/plain';
      return '';
    }

    setFileType(guessType(ext));
    setDataUrl(undefined);
    setTextContent(undefined);
    setError(undefined);
    setFullText(undefined);
    setIsTruncated(false);
    setArchiveInfo(undefined);
    setExternalTool(undefined);

    const finishLoading = () => {
      if (!cancelled) {
        setIsLoading(false);
      }
    };

    // Image preview
    if (file.path && ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext)) {
      const fallbackToEmbedded = async () => {
        if (cancelled) return;
        if (fallbackInFlightRef.current) return;
        fallbackInFlightRef.current = true;
        try {
          const binary = await readBinaryFile(file.path);
          if (cancelled) return;
          const bytes =
            binary instanceof Uint8Array ? binary : new Uint8Array(binary as ArrayBufferLike);
          const mime = guessType(ext) || 'image/*';
          const dataUrl = `data:${mime};base64,${uint8ToBase64(bytes)}`;
          setCachedPreview(file.path, dataUrl);
          setDataUrl(dataUrl);
          setError(undefined);
        } catch (err) {
          if (!cancelled) {
            console.error('Failed to load image preview', err);
            setError('Failed to load image preview.');
            finishLoading();
          }
        } finally {
          fallbackInFlightRef.current = false;
          fallbackHandlerRef.current = null;
        }
      };

      fallbackHandlerRef.current = fallbackToEmbedded;

      const cached = getCachedPreview(file.path);
      if (cached) {
        setDataUrl(cached);
        setError(undefined);
      } else {
        const src = toPreviewSrc(file.path);
        if (src) {
          setDataUrl(src);
          setError(undefined);
        } else {
          void fallbackToEmbedded();
        }
      }

      return () => {
        cancelled = true;
        fallbackHandlerRef.current = null;
        fallbackInFlightRef.current = false;
      };
    }

    // PDF preview
    if (file.path && ext === 'pdf') {
      const src = toPreviewSrc(file.path);
      setDataUrl(src);
      finishLoading();
      return () => {
        cancelled = true;
      };
    }

    // Video preview
    if (file.path && providerKind === 'browser-video') {
      const src = toPreviewSrc(file.path);
      setDataUrl(src);
      finishLoading();
      return () => {
        cancelled = true;
      };
    }

    // Audio preview
    if (file.path && ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma'].includes(ext)) {
      const src = toPreviewSrc(file.path);
      setDataUrl(src);
      finishLoading();
      return () => {
        cancelled = true;
      };
    }

    // Text preview
    if (file.path && isTextExtension(ext)) {
      readTextFile(file.path)
        .then((text: string) => {
          if (cancelled) return;
          const MAX = 128 * 1024; // 128KB
          if (text.length > MAX) {
            setFullText(text);
            setTextContent(text.slice(0, MAX));
            setIsTruncated(true);
          } else {
            setFullText(text);
            setTextContent(text);
            setIsTruncated(false);
          }
          finishLoading();
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setTextContent(undefined);
            setError('Failed to load text: ' + formatErrorMessage(e));
            finishLoading();
          }
        });
      return () => {
        cancelled = true;
      };
    }

    // Archive preview
    if (file.path && providerKind === 'archive') {
      invoke<ArchivePreviewInfo>('list_archive', { archivePath: file.path })
        .then((info) => {
          if (cancelled) return;
          setArchiveInfo(info);
          setFileType('application/x-explorie-archive');
          finishLoading();
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setError('Failed to load archive preview: ' + formatErrorMessage(e));
            finishLoading();
          }
        });
      return () => {
        cancelled = true;
      };
    }

    // External generated previews: LibreOffice, FFmpeg, ImageMagick
    if (
      file.path &&
      (providerKind === 'external-document' ||
        providerKind === 'external-video' ||
        providerKind === 'external-image')
    ) {
      invoke<PreviewArtifact>('generate_preview_artifact', { path: file.path })
        .then((artifact) => {
          if (cancelled) return;
          setDataUrl(toPreviewSrc(artifact.path));
          setFileType(artifact.mime_type || (artifact.kind === 'pdf' ? 'application/pdf' : ''));
          setExternalTool(artifact.tool);
          finishLoading();
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setError('Failed to generate preview: ' + formatErrorMessage(e));
            finishLoading();
          }
        });
      return () => {
        cancelled = true;
      };
    }

    // For other types, nothing async to load
    finishLoading();
    return () => {
      cancelled = true;
    };
  }, [file, file.path, file.id, toPreviewSrc, previewExecutableScripts]);

  // Handle file updates from the custom fields editor
  const handleFileUpdate = (updatedFile: FileEntry) => {
    setCurrentFile(updatedFile);

    // Also update the file in the global store to reflect custom field changes
    const { files } = useFileStore.getState();
    const updatedFiles = files.map((f: FileEntry) => (f.id === updatedFile.id ? updatedFile : f));
    setFiles(updatedFiles);
  };

  // If there was an error loading the file, show it in the preview
  if (error) {
    return (
      <Preview
        file={{
          name: file.name || file.path.split('/').pop() || file.path,
          path: file.path,
          type: 'error',
          url: undefined,
          content: error,
        }}
        onClose={onClose}
      />
    );
  }

  type PreviewFilePayload = FileEntry & {
    type: string;
    url?: string;
    content?: string;
    archiveInfo?: ArchivePreviewInfo;
    externalTool?: string;
  };

  // Create preview payload that carries both metadata (FileEntry) and preview url/content.
  const previewFile = {
    ...currentFile,
    name: currentFile.name ?? file.path.split(/[/\\]/).pop() ?? file.path,
    path: currentFile.path,
    type: fileType || '',
    url: dataUrl,
    content: textContent,
    archiveInfo,
    externalTool,
  } as PreviewFilePayload;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
      <Preview
        file={previewFile}
        onClose={onClose}
        onUpdate={handleFileUpdate}
        loading={isLoading}
        onReady={handlePreviewReady}
        onContentError={handlePreviewError}
        variant={variant}
      />
      {fileType.startsWith('text') && typeof textContent === 'string' && isTruncated && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button
            onClick={() => {
              if (fullText) {
                setTextContent(fullText);
                setIsTruncated(false);
              }
            }}
            title="Load full file contents"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

export default FilePreviewer;
