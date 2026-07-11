import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePreviewer } from './FilePreviewer';
import type { FileEntry } from '../store';

type StoreState = {
  setFiles: (files: FileEntry[]) => void;
  previewExecutableScripts: boolean;
  files: FileEntry[];
};

let storeState: StoreState;

const mocks = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string, _protocol?: string) => path),
  getCachedPreview: vi.fn(),
  invoke: vi.fn(),
  readBinaryFile: vi.fn(),
  setCachedPreview: vi.fn(),
}));

vi.mock('../store', () => {
  const useFileStore = (selector?: (state: StoreState) => any) => {
    return selector ? selector(storeState) : storeState;
  };
  useFileStore.getState = () => storeState;
  return { useFileStore };
});

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string, protocol?: string) => mocks.convertFileSrc(path, protocol),
  invoke: (command: string, args?: Record<string, unknown>) => mocks.invoke(command, args),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: (path: string) => mocks.readBinaryFile(path),
}));

vi.mock('../utils/previewCache', () => ({
  getCachedPreview: (path: string) => mocks.getCachedPreview(path),
  setCachedPreview: (path: string, dataUrl: string) => mocks.setCachedPreview(path, dataUrl),
}));

vi.mock('./Preview', () => ({
  Preview: ({
    file,
    loading,
    onClose,
    onContentError,
    onReady,
    onUpdate,
  }: {
    file: {
      id?: string;
      name?: string;
      path: string;
      type?: string;
      url?: string;
      content?: string;
      size?: number;
      modified?: number;
      is_dir?: boolean;
      custom?: Record<string, unknown>;
      archiveInfo?: { entry_count: number };
    };
    loading?: boolean;
    onClose?: () => void;
    onContentError?: () => void;
    onReady?: () => void;
    onUpdate?: (file: any) => void;
  }) => (
    <section
      data-testid="preview"
      data-name={file.name ?? ''}
      data-path={file.path}
      data-type={file.type ?? ''}
      data-url={file.url ?? ''}
      data-loading={String(Boolean(loading))}
      data-archive-count={file.archiveInfo?.entry_count ?? ''}
    >
      <div data-testid="preview-content-length">{file.content ? file.content.length : 0}</div>
      <div data-testid="preview-content-sample">{file.content?.slice(0, 80) ?? ''}</div>
      <button onClick={onClose}>close preview</button>
      <button onClick={onContentError}>content error</button>
      <button onClick={onReady}>preview ready</button>
      <button
        onClick={() =>
          onUpdate?.({
            ...file,
            id: file.id ?? 'file-1',
            name: `${file.name ?? 'file'} updated`,
            size: file.size ?? 0,
            modified: file.modified ?? 0,
            is_dir: file.is_dir ?? false,
            custom: { ...(file.custom ?? {}), reviewed: true },
          })
        }
      >
        update preview file
      </button>
    </section>
  ),
}));

describe('FilePreviewer', () => {
  const mockTextPreview = (text: string, truncated = false) => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'read_text_preview') return { text, truncated };
      return undefined;
    });
  };

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    storeState = {
      setFiles: vi.fn(),
      previewExecutableScripts: false,
      files: [],
    };
    mocks.convertFileSrc.mockReset();
    mocks.convertFileSrc.mockImplementation((path: string, _protocol?: string) => path);
    mocks.getCachedPreview.mockReset();
    mocks.getCachedPreview.mockReturnValue(undefined);
    mocks.invoke.mockReset();
    mocks.readBinaryFile.mockReset();
    mocks.setCachedPreview.mockReset();
  });

  it('keeps truncated text previews bounded', async () => {
    const previewText = 'a'.repeat(128 * 1024);
    mockTextPreview(previewText, true);

    render(
      <FilePreviewer
        file={{
          id: 'file-1',
          path: '/root/readme.txt',
          size: 0,
          modified: 0,
          is_dir: false,
          custom: {},
        }}
      />
    );

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Preview limited to the first 128 KB'
    );
    expect(screen.getByTestId('preview-content-length')).toHaveTextContent('131072');
    expect(mocks.invoke).toHaveBeenCalledWith('read_text_preview', {
      path: '/root/readme.txt',
      maxBytes: 128 * 1024,
    });
  });

  it('loads text files and propagates preview updates to the file store', async () => {
    const user = userEvent.setup();
    const file = makeFile('/root/readme.txt', { id: 'readme', name: 'readme.txt' });
    storeState.files = [file, makeFile('/root/other.txt', { id: 'other', name: 'other.txt' })];
    mockTextPreview('hello from explorie');

    render(<FilePreviewer file={file} />);

    await waitFor(() =>
      expect(screen.getByTestId('preview')).toHaveAttribute('data-loading', 'false')
    );
    expect(mocks.invoke).toHaveBeenCalledWith('read_text_preview', {
      path: '/root/readme.txt',
      maxBytes: 128 * 1024,
    });
    expect(screen.getByTestId('preview')).toHaveAttribute('data-type', 'text/plain');
    expect(screen.getByTestId('preview-content-length')).toHaveTextContent('19');
    expect(screen.getByTestId('preview-content-sample')).toHaveTextContent('hello from explorie');

    await user.click(screen.getByRole('button', { name: 'update preview file' }));

    expect(storeState.setFiles).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'readme',
        name: 'readme.txt updated',
        custom: { reviewed: true },
      }),
      expect.objectContaining({ id: 'other' }),
    ]);
    expect(screen.getByTestId('preview')).toHaveAttribute('data-name', 'readme.txt updated');
  });

  it('loads text-like provider formats beyond the legacy extension list', async () => {
    mockTextPreview('name: explorie');

    render(<FilePreviewer file={makeFile('/root/config.yaml')} />);

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('read_text_preview', {
        path: '/root/config.yaml',
        maxBytes: 128 * 1024,
      })
    );
    expect(screen.getByTestId('preview')).toHaveAttribute('data-type', 'text/plain');
    expect(screen.getByTestId('preview-content-sample')).toHaveTextContent('name: explorie');
  });

  it('shows formatted text loading errors in an error preview', async () => {
    mocks.invoke.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    render(<FilePreviewer file={makeFile('/root/missing.txt')} />);

    await waitFor(() =>
      expect(screen.getByTestId('preview')).toHaveAttribute('data-type', 'error')
    );
    expect(screen.getByTestId('preview-content-sample')).toHaveTextContent(
      'Failed to load text: File or folder not found'
    );
  });

  it('only previews executable scripts when the setting is enabled', async () => {
    const scriptFile = makeFile('/root/install.ps1');
    const { unmount } = render(<FilePreviewer file={scriptFile} />);

    await waitFor(() =>
      expect(screen.getByTestId('preview')).toHaveAttribute('data-loading', 'false')
    );
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      'read_text_preview',
      expect.objectContaining({ path: '/root/install.ps1' })
    );
    expect(screen.getByTestId('preview')).toHaveAttribute('data-type', '');

    unmount();
    cleanup();
    storeState.previewExecutableScripts = true;
    mockTextPreview('Write-Host "hello"');

    render(<FilePreviewer file={scriptFile} />);

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('read_text_preview', {
        path: '/root/install.ps1',
        maxBytes: 128 * 1024,
      })
    );
    expect(screen.getByTestId('preview')).toHaveAttribute('data-type', 'text/plain');
    expect(screen.getByTestId('preview-content-sample')).toHaveTextContent('Write-Host "hello"');
  });

  it('uses cached image previews before converting file paths', () => {
    mocks.getCachedPreview.mockReturnValue('data:image/png;base64,cached');

    render(<FilePreviewer file={makeFile('/root/cat.png')} />);

    expect(mocks.getCachedPreview).toHaveBeenCalledWith('/root/cat.png');
    expect(mocks.convertFileSrc).not.toHaveBeenCalled();
    expect(screen.getByTestId('preview')).toHaveAttribute('data-type', 'image/png');
    expect(screen.getByTestId('preview')).toHaveAttribute(
      'data-url',
      'data:image/png;base64,cached'
    );
  });

  it('converts image paths and clears loading when the preview reports ready', async () => {
    const user = userEvent.setup();
    mocks.convertFileSrc.mockReturnValue('http://asset.localhost/root/cat.png');

    render(<FilePreviewer file={makeFile('/root/cat.png')} />);

    expect(screen.getByTestId('preview')).toHaveAttribute(
      'data-url',
      'http://asset.localhost/root/cat.png'
    );
    expect(screen.getByTestId('preview')).toHaveAttribute('data-loading', 'true');

    await user.click(screen.getByRole('button', { name: 'preview ready' }));

    expect(screen.getByTestId('preview')).toHaveAttribute('data-loading', 'false');
  });

  it('preserves Tauri asset URLs for browser PDF and video previews', async () => {
    mocks.convertFileSrc.mockImplementation((path: string) => `http://asset.localhost/${path}`);
    const { unmount } = render(<FilePreviewer file={makeFile('C:/Docs/guide.pdf')} />);

    await waitFor(() =>
      expect(screen.getByTestId('preview')).toHaveAttribute('data-loading', 'false')
    );
    expect(screen.getByTestId('preview')).toHaveAttribute('data-type', 'application/pdf');
    expect(screen.getByTestId('preview')).toHaveAttribute(
      'data-url',
      'http://asset.localhost/C:/Docs/guide.pdf'
    );

    unmount();
    cleanup();

    render(<FilePreviewer file={makeFile('C:/Media/demo.mp4')} />);

    await waitFor(() =>
      expect(screen.getByTestId('preview')).toHaveAttribute('data-loading', 'false')
    );
    expect(screen.getByTestId('preview')).toHaveAttribute('data-type', 'video/mp4');
    expect(screen.getByTestId('preview')).toHaveAttribute(
      'data-url',
      'http://asset.localhost/C:/Media/demo.mp4'
    );
  });

  it('falls back to an embedded image data URL when rendered image loading fails', async () => {
    const user = userEvent.setup();
    mocks.convertFileSrc.mockReturnValue('asset://root/cat.png');
    mocks.readBinaryFile.mockResolvedValue(new Uint8Array([104, 105]));

    render(<FilePreviewer file={makeFile('/root/cat.png')} />);

    await user.click(screen.getByRole('button', { name: 'content error' }));

    await waitFor(() => expect(mocks.readBinaryFile).toHaveBeenCalledWith('/root/cat.png'));
    expect(mocks.setCachedPreview).toHaveBeenCalledWith(
      '/root/cat.png',
      'data:image/png;base64,aGk='
    );
    expect(screen.getByTestId('preview')).toHaveAttribute('data-url', 'data:image/png;base64,aGk=');
  });

  it('shows an image preview error when the embedded fallback cannot read the file', async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.convertFileSrc.mockReturnValue('asset://root/broken.png');
    mocks.readBinaryFile.mockRejectedValue(new Error('read failed'));

    render(<FilePreviewer file={makeFile('/root/broken.png')} />);

    await user.click(screen.getByRole('button', { name: 'content error' }));

    await waitFor(() =>
      expect(screen.getByTestId('preview')).toHaveAttribute('data-type', 'error')
    );
    expect(screen.getByTestId('preview-content-sample')).toHaveTextContent(
      'Failed to load image preview.'
    );
    expect(consoleError).toHaveBeenCalledWith('Failed to load image preview', expect.any(Error));
  });

  it('falls back to file URLs for previewable media when Tauri path conversion fails', async () => {
    mocks.convertFileSrc.mockImplementation(() => {
      throw new Error('convert unavailable');
    });

    render(<FilePreviewer file={makeFile('C:/Docs/guide.pdf')} />);

    await waitFor(() =>
      expect(screen.getByTestId('preview')).toHaveAttribute('data-loading', 'false')
    );
    expect(screen.getByTestId('preview')).toHaveAttribute('data-type', 'application/pdf');
    expect(screen.getByTestId('preview')).toHaveAttribute('data-url', 'file:///C:/Docs/guide.pdf');
  });

  it('loads archive listings as Quick Look archive previews', async () => {
    mocks.invoke.mockResolvedValue({
      format: 'zip',
      entry_count: 2,
      total_size: 1024,
      compressed_size: 512,
      entries: [
        { path: 'docs/readme.md', size: 128, compressed_size: 64, is_dir: false },
        { path: 'assets/', size: 0, compressed_size: 0, is_dir: true },
      ],
    });

    render(<FilePreviewer file={makeFile('/root/bundle.zip')} />);

    await waitFor(() =>
      expect(screen.getByTestId('preview')).toHaveAttribute('data-loading', 'false')
    );
    expect(mocks.invoke).toHaveBeenCalledWith('list_archive', { archivePath: '/root/bundle.zip' });
    expect(screen.getByTestId('preview')).toHaveAttribute(
      'data-type',
      'application/x-explorie-archive'
    );
    expect(screen.getByTestId('preview')).toHaveAttribute('data-archive-count', '2');
  });

  it('loads externally generated document previews as PDFs', async () => {
    mocks.invoke.mockResolvedValue({
      kind: 'pdf',
      path: 'C:/Temp/explorie-preview-cache/report.pdf',
      mime_type: 'application/pdf',
      tool: 'soffice',
    });
    mocks.convertFileSrc.mockReturnValue('asset://preview/report.pdf');

    render(<FilePreviewer file={makeFile('C:/Docs/report.docx')} />);

    await waitFor(() =>
      expect(screen.getByTestId('preview')).toHaveAttribute('data-loading', 'false')
    );
    expect(mocks.invoke).toHaveBeenCalledWith('generate_preview_artifact', {
      path: 'C:/Docs/report.docx',
    });
    expect(screen.getByTestId('preview')).toHaveAttribute('data-type', 'application/pdf');
    expect(screen.getByTestId('preview')).toHaveAttribute('data-url', 'asset://preview/report.pdf');
  });

  it('loads externally generated media previews as images', async () => {
    mocks.invoke.mockResolvedValue({
      kind: 'image',
      path: 'C:/Temp/explorie-preview-cache/movie.png',
      mime_type: 'image/png',
      tool: 'ffmpeg',
    });
    mocks.convertFileSrc.mockReturnValue('asset://preview/movie.png');

    render(<FilePreviewer file={makeFile('C:/Media/movie.avi')} />);

    await waitFor(() =>
      expect(screen.getByTestId('preview')).toHaveAttribute('data-loading', 'false')
    );
    expect(mocks.invoke).toHaveBeenCalledWith('generate_preview_artifact', {
      path: 'C:/Media/movie.avi',
    });
    expect(screen.getByTestId('preview')).toHaveAttribute('data-type', 'image/png');
    expect(screen.getByTestId('preview')).toHaveAttribute('data-url', 'asset://preview/movie.png');
  });

  it('shows actionable helper errors when external preview tools are missing', async () => {
    mocks.invoke.mockRejectedValue(new Error('Install LibreOffice to preview Office files.'));

    render(<FilePreviewer file={makeFile('C:/Docs/report.docx')} />);

    await waitFor(() =>
      expect(screen.getByTestId('preview')).toHaveAttribute('data-type', 'error')
    );
    expect(screen.getByTestId('preview-content-sample')).toHaveTextContent('Install LibreOffice');
  });
});

function makeFile(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: overrides.id ?? path,
    path,
    name: overrides.name,
    size: overrides.size ?? 0,
    modified: overrides.modified ?? 0,
    is_dir: overrides.is_dir ?? false,
    custom: overrides.custom ?? {},
  };
}
