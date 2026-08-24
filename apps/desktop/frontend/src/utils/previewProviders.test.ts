import { describe, expect, it } from 'vitest';
import {
  describeExternalPreviewFailure,
  getPreviewHelperName,
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

  it('names the helper required for office, video, and HEIC previews', () => {
    expect(getPreviewHelperName(getPreviewProviderKind('/docs/report.docx'))).toBe('LibreOffice');
    expect(getPreviewHelperName(getPreviewProviderKind('/media/clip.mov'))).toBe('FFmpeg');
    expect(getPreviewHelperName(getPreviewProviderKind('/images/photo.heic'))).toBe('ImageMagick');
    expect(getPreviewHelperName(getPreviewProviderKind('/images/logo.png'))).toBeNull();
  });

  it('keeps helper-specific install errors and otherwise names the helper and retry', () => {
    expect(
      describeExternalPreviewFailure(
        'external-document',
        'Install LibreOffice to preview Office and OpenDocument files.'
      )
    ).toBe('Install LibreOffice to preview Office and OpenDocument files.');
    expect(describeExternalPreviewFailure('external-video', 'Conversion failed.')).toBe(
      'FFmpeg could not generate this preview. Conversion failed. Install FFmpeg, then retry.'
    );
    expect(
      describeExternalPreviewFailure(
        'external-image',
        'ImageMagick could not convert this image for preview.'
      )
    ).toBe(
      'ImageMagick could not convert this image for preview. Install ImageMagick, then retry.'
    );
  });
});
