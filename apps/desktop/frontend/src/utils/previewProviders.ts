export type PreviewProviderKind =
  | 'browser-image'
  | 'browser-video'
  | 'browser-audio'
  | 'pdf'
  | 'text'
  | 'archive'
  | 'external-document'
  | 'external-video'
  | 'external-image'
  | 'unsupported';

const BROWSER_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg']);
const BROWSER_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'm4v']);
const BROWSER_AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'wma']);

const TEXT_PREVIEW_EXTENSIONS = new Set([
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
  'sql',
  'html',
  'htm',
  'xml',
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

const EXTERNAL_DOCUMENT_EXTENSIONS = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
]);

const EXTERNAL_VIDEO_EXTENSIONS = new Set([
  'mov',
  'avi',
  'mkv',
  'wmv',
  'flv',
  'm2ts',
  'mts',
  'mpeg',
  'mpg',
  '3gp',
]);

const EXTERNAL_IMAGE_EXTENSIONS = new Set(['heic', 'heif', 'tif', 'tiff', 'psd']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar']);

export function getPreviewExtension(path: string): string {
  const cleanPath = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? '';
  if (cleanPath.endsWith('.tar.gz')) return 'tar.gz';
  const name = cleanPath.split(/[/\\]/).pop() ?? cleanPath;
  const dotIndex = name.lastIndexOf('.');
  return dotIndex >= 0 ? name.slice(dotIndex + 1) : '';
}

export function isArchivePreviewExtension(path: string): boolean {
  const ext = getPreviewExtension(path);
  return ext === 'tar.gz' || ARCHIVE_EXTENSIONS.has(ext);
}

export function isExternalDocumentPreviewExtension(path: string): boolean {
  return EXTERNAL_DOCUMENT_EXTENSIONS.has(getPreviewExtension(path));
}

export function isExternalVideoPreviewExtension(path: string): boolean {
  return EXTERNAL_VIDEO_EXTENSIONS.has(getPreviewExtension(path));
}

export function isExternalImagePreviewExtension(path: string): boolean {
  return EXTERNAL_IMAGE_EXTENSIONS.has(getPreviewExtension(path));
}

export function getPreviewProviderKind(path: string): PreviewProviderKind {
  const ext = getPreviewExtension(path);

  if (BROWSER_IMAGE_EXTENSIONS.has(ext)) return 'browser-image';
  if (ext === 'pdf') return 'pdf';
  if (BROWSER_VIDEO_EXTENSIONS.has(ext)) return 'browser-video';
  if (BROWSER_AUDIO_EXTENSIONS.has(ext)) return 'browser-audio';
  if (TEXT_PREVIEW_EXTENSIONS.has(ext)) return 'text';
  if (isArchivePreviewExtension(path)) return 'archive';
  if (isExternalDocumentPreviewExtension(path)) return 'external-document';
  if (isExternalVideoPreviewExtension(path)) return 'external-video';
  if (isExternalImagePreviewExtension(path)) return 'external-image';

  return 'unsupported';
}
