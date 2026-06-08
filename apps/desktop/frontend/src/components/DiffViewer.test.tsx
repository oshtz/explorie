import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffViewer } from './DiffViewer';

const mocks = vi.hoisted(() => ({
  readDir: vi.fn(),
  readFile: vi.fn(),
  readTextFile: vi.fn(),
  stat: vi.fn(),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: mocks.readDir,
  readFile: mocks.readFile,
  readTextFile: mocks.readTextFile,
  stat: mocks.stat,
}));

vi.mock('./Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

vi.mock('../utils/highlight', () => ({
  resolveHighlightLanguage: vi.fn(() => 'plaintext'),
  highlightCode: vi.fn((content: string) => `<mark>${content}</mark>`),
}));

function file(path: string, isDir = false) {
  const parts = path.split('/');
  return {
    path,
    name: parts[parts.length - 1],
    isDir,
  };
}

function renderViewer(overrides: Partial<React.ComponentProps<typeof DiffViewer>> = {}) {
  const props: React.ComponentProps<typeof DiffViewer> = {
    open: true,
    onClose: vi.fn(),
    leftFile: file('/left/readme.txt'),
    rightFile: file('/right/readme.txt'),
    ...overrides,
  };

  return {
    user: userEvent.setup(),
    props,
    ...render(<DiffViewer {...props} />),
  };
}

describe('DiffViewer', () => {
  beforeEach(() => {
    mocks.readDir.mockReset();
    mocks.readFile.mockReset();
    mocks.readTextFile.mockReset();
    mocks.stat.mockReset();
    mocks.createObjectURL.mockReset();
    mocks.revokeObjectURL.mockReset();

    mocks.readTextFile.mockImplementation(async (path: string) =>
      path.startsWith('/left/') ? 'alpha\nold line\ncommon\n' : 'alpha\nnew line\ncommon\nextra\n'
    );
    mocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));

    let blobCounter = 0;
    mocks.createObjectURL.mockImplementation(() => {
      blobCounter += 1;
      return `blob:mock-${blobCounter}`;
    });

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: mocks.createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: mocks.revokeObjectURL,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing when closed and lets users choose missing files', async () => {
    const onSelectFile = vi.fn();
    const { rerender, user } = renderViewer({
      open: false,
      leftFile: null,
      rightFile: null,
      onSelectFile,
    });

    expect(screen.queryByText('Compare Files')).not.toBeInTheDocument();

    rerender(
      <DiffViewer
        open
        onClose={vi.fn()}
        leftFile={null}
        rightFile={null}
        onSelectFile={onSelectFile}
      />
    );

    expect(screen.getByText('Select two files to compare')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Select left file...' }));
    await user.click(screen.getByRole('button', { name: 'Select right file...' }));

    expect(onSelectFile).toHaveBeenCalledWith('left');
    expect(onSelectFile).toHaveBeenCalledWith('right');
  });

  it('loads text files, switches diff modes, navigates changes, and closes from Escape', async () => {
    const onClose = vi.fn();
    const { user, container } = renderViewer({ onClose });

    await waitFor(() => expect(mocks.readTextFile).toHaveBeenCalledTimes(2));

    expect(screen.getByText('Compare Files')).toBeVisible();
    expect(screen.getAllByText('readme.txt')).toHaveLength(2);
    expect(container).toHaveTextContent('old line');
    expect(container).toHaveTextContent('new line');
    expect(container).toHaveTextContent('removed');
    expect(container).toHaveTextContent('added');

    await user.selectOptions(screen.getByRole('combobox'), 'words');
    await user.click(screen.getByTitle('Inline view'));
    await user.selectOptions(screen.getByRole('combobox'), 'chars');
    await user.click(screen.getByTitle('Next change (Ctrl+Down)'));
    await user.click(screen.getByTitle('Previous change (Ctrl+Up)'));
    await user.click(screen.getByTitle('Disable syntax highlighting'));

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows file-loading errors', async () => {
    mocks.readTextFile.mockRejectedValue(new Error('permission denied'));

    renderViewer();

    expect(await screen.findByText(/Failed to load files:/)).toHaveTextContent('Access denied');
  });

  it('loads image comparisons and switches overlay and slider controls', async () => {
    const { user } = renderViewer({
      leftFile: file('/left/photo.png'),
      rightFile: file('/right/photo.png'),
    });

    await waitFor(() => expect(mocks.readFile).toHaveBeenCalledTimes(2));

    expect(screen.getByText('Compare Images')).toBeVisible();
    expect(screen.getByRole('img', { name: 'Left' })).toHaveAttribute('src', 'blob:mock-1');
    expect(screen.getByRole('img', { name: 'Right' })).toHaveAttribute('src', 'blob:mock-2');

    await user.click(screen.getByTitle('Overlay'));
    const opacitySlider = screen.getByRole('slider');
    fireEvent.change(opacitySlider, { target: { value: '0.75' } });
    expect(opacitySlider).toHaveValue('0.75');

    await user.click(screen.getByTitle('Slider'));
    const compareSlider = screen.getByRole('slider');
    fireEvent.change(compareSlider, { target: { value: '65' } });
    expect(compareSlider).toHaveValue('65');
  });

  it('compares folders by status and size', async () => {
    mocks.readDir.mockImplementation(async (path: string) => {
      if (path === '/left') {
        return [
          { name: 'folder', isDirectory: true },
          { name: 'changed.txt', isDirectory: false },
          { name: 'left-only.txt', isDirectory: false },
          { name: 'same.txt', isDirectory: false },
        ];
      }

      return [
        { name: 'folder', isDirectory: true },
        { name: 'changed.txt', isDirectory: false },
        { name: 'right-only.txt', isDirectory: false },
        { name: 'same.txt', isDirectory: false },
      ];
    });
    mocks.stat.mockImplementation(async (path: string) => ({
      size: path.includes('changed.txt') && path.startsWith('/right') ? 2048 : 1024,
      mtime: new Date('2026-01-15T12:00:00Z'),
      isDirectory: path.endsWith('/folder'),
    }));

    const { container } = renderViewer({
      compareMode: 'folders',
      leftFile: file('/left', true),
      rightFile: file('/right', true),
    });

    expect(await screen.findByText('changed.txt')).toBeVisible();
    expect(screen.getByText('left-only.txt')).toBeVisible();
    expect(screen.getByText('right-only.txt')).toBeVisible();
    expect(screen.getByText('same.txt')).toBeVisible();
    expect(container).toHaveTextContent('1 left only');
    expect(container).toHaveTextContent('1 right only');
    expect(container).toHaveTextContent('1 different');
    expect(container).toHaveTextContent('2 identical');
  });

  it('shows folder comparison errors', async () => {
    mocks.readDir.mockRejectedValue(new Error('directory unavailable'));

    renderViewer({
      compareMode: 'folders',
      leftFile: file('/left', true),
      rightFile: file('/right', true),
    });

    expect(await screen.findByText(/Failed to compare folders:/)).toHaveTextContent(
      'Directory unavailable'
    );
  });
});
