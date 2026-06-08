import { describe, expect, it } from 'vitest';
import {
  getPreviewProviderKind,
  isArchivePreviewExtension,
  isExternalDocumentPreviewExtension,
  isExternalImagePreviewExtension,
  isExternalVideoPreviewExtension,
} from './previewProviders';

describe('previewProviders', () => {
  it('routes office-like documents to external document conversion', () => {
    for (const path of [
      '/docs/report.doc',
      '/docs/report.docx',
      '/docs/sheet.xlsx',
      '/docs/slides.pptx',
      '/docs/document.odt',
      '/docs/notes.rtf',
    ]) {
      expect(isExternalDocumentPreviewExtension(path)).toBe(true);
      expect(getPreviewProviderKind(path)).toBe('external-document');
    }
  });

  it('routes non-browser video files to external video thumbnails', () => {
    for (const path of [
      '/media/legacy.avi',
      '/media/clip.mov',
      '/media/movie.mkv',
      '/media/capture.wmv',
      '/media/clip.flv',
      '/media/camera.m2ts',
    ]) {
      expect(isExternalVideoPreviewExtension(path)).toBe(true);
      expect(getPreviewProviderKind(path)).toBe('external-video');
    }
  });

  it('routes non-browser image files to external image conversion', () => {
    for (const path of [
      '/images/photo.heic',
      '/images/photo.heif',
      '/images/scan.tif',
      '/images/scan.tiff',
      '/images/design.psd',
    ]) {
      expect(isExternalImagePreviewExtension(path)).toBe(true);
      expect(getPreviewProviderKind(path)).toBe('external-image');
    }
  });

  it('routes archive files to archive previews', () => {
    for (const path of [
      '/archives/release.zip',
      '/archives/source.tar',
      '/archives/source.tar.gz',
      '/archives/assets.7z',
      '/archives/legacy.rar',
    ]) {
      expect(isArchivePreviewExtension(path)).toBe(true);
      expect(getPreviewProviderKind(path)).toBe('archive');
    }
  });

  it('keeps browser-native and text formats on local frontend providers', () => {
    expect(getPreviewProviderKind('/images/logo.png')).toBe('browser-image');
    expect(getPreviewProviderKind('/docs/readme.md')).toBe('text');
    expect(getPreviewProviderKind('/docs/manual.pdf')).toBe('pdf');
    expect(getPreviewProviderKind('/media/video.mp4')).toBe('browser-video');
    expect(getPreviewProviderKind('/media/audio.mp3')).toBe('browser-audio');
  });
});
