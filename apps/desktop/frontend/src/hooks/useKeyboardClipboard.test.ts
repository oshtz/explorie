import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../store';
import { useOperationQueueStore } from '../operationQueueStore';
import { useKeyboardClipboardManager } from './useKeyboardClipboard';

const mocks = vi.hoisted(() => ({
  copyWithUndoAndConflictResolution: vi.fn(),
  moveWithUndoAndConflictResolution: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('../utils/fileOperations', () => ({
  copyWithUndoAndConflictResolution: mocks.copyWithUndoAndConflictResolution,
  moveWithUndoAndConflictResolution: mocks.moveWithUndoAndConflictResolution,
}));

vi.mock('../utils/errorReporter', () => ({
  reportError: mocks.reportError,
}));

function file(name: string): FileEntry {
  return {
    id: name,
    path: `/source/${name}`,
    name,
    size: 128,
    modified: '2026-01-15T12:00:00Z',
    hidden: false,
    is_dir: false,
    custom: {},
  };
}

function renderClipboard(
  overrides: Partial<Parameters<typeof useKeyboardClipboardManager>[0]> = {}
) {
  const props = {
    currentPath: '/target',
    setClipboard: vi.fn(),
    clipboard: null,
    showToast: vi.fn(),
    onRefresh: vi.fn(async () => {}),
    ...overrides,
  };

  return {
    props,
    ...renderHook(() => useKeyboardClipboardManager(props)),
  };
}

describe('useKeyboardClipboardManager', () => {
  beforeEach(() => {
    mocks.copyWithUndoAndConflictResolution.mockReset();
    mocks.moveWithUndoAndConflictResolution.mockReset();
    mocks.reportError.mockReset();
    mocks.copyWithUndoAndConflictResolution.mockResolvedValue(undefined);
    mocks.moveWithUndoAndConflictResolution.mockResolvedValue(undefined);
    useOperationQueueStore.setState({ defaultConflictResolution: 'ask' });
  });

  it('copies and cuts registered selections with user-facing toast messages', () => {
    const selected = [file('one.txt'), file('two.txt')];
    const { result, props } = renderClipboard({ currentPath: '/source' });
    result.current.getSelectedFilesRef.current = () => selected;

    act(() => {
      expect(result.current.handleCopy()).toBe(true);
    });

    expect(props.setClipboard).toHaveBeenCalledWith({
      mode: 'copy',
      items: selected,
      sourcePath: '/source',
    });
    expect(props.showToast).toHaveBeenCalledWith('Copied 2 items', { type: 'success' });

    act(() => {
      expect(result.current.handleCut()).toBe(true);
    });

    expect(props.setClipboard).toHaveBeenLastCalledWith({
      mode: 'cut',
      items: selected,
      sourcePath: '/source',
    });
    expect(props.showToast).toHaveBeenCalledWith('Cut 2 items', { type: 'success' });
  });

  it('returns false for copy/cut without registered or selected files', () => {
    const { result } = renderClipboard();

    expect(result.current.handleCopy()).toBe(false);

    result.current.getSelectedFilesRef.current = () => [];

    expect(result.current.handleCopy()).toBe(false);
    expect(result.current.handleCut()).toBe(false);
  });

  it('pastes copy and cut clipboards with conflict resolution mapping', async () => {
    useOperationQueueStore.setState({ defaultConflictResolution: 'rename' });
    const copied = [file('copy.txt')];
    const copyRender = renderClipboard({
      clipboard: {
        mode: 'copy',
        items: copied,
        sourcePath: '/source',
      },
    });

    await act(async () => {
      await expect(copyRender.result.current.handlePaste()).resolves.toBe(true);
    });

    expect(mocks.copyWithUndoAndConflictResolution).toHaveBeenCalledWith(
      copied,
      '/target',
      copyRender.props.showToast,
      copyRender.props.onRefresh,
      { conflictResolution: 'keepBoth' }
    );
    expect(copyRender.props.setClipboard).not.toHaveBeenCalledWith(null);

    const cut = [file('cut.txt')];
    const cutRender = renderClipboard({
      clipboard: {
        mode: 'cut',
        items: cut,
        sourcePath: '/source',
      },
    });

    await act(async () => {
      await expect(cutRender.result.current.handlePaste()).resolves.toBe(true);
    });

    expect(mocks.moveWithUndoAndConflictResolution).toHaveBeenCalledWith(
      cut,
      '/target',
      cutRender.props.showToast,
      cutRender.props.onRefresh,
      { conflictResolution: 'keepBoth' }
    );
    expect(cutRender.props.setClipboard).toHaveBeenCalledWith(null);
  });

  it('reports invalid and failed paste attempts', async () => {
    const empty = renderClipboard();

    await act(async () => {
      await expect(empty.result.current.handlePaste()).resolves.toBe(false);
    });
    expect(empty.props.showToast).toHaveBeenCalledWith('Nothing to paste', { type: 'info' });

    const samePath = renderClipboard({
      currentPath: '/source',
      clipboard: {
        mode: 'copy',
        items: [file('same.txt')],
        sourcePath: '/source',
      },
    });

    await act(async () => {
      await expect(samePath.result.current.handlePaste()).resolves.toBe(false);
    });
    expect(samePath.props.showToast).toHaveBeenCalledWith('Cannot paste to the same location', {
      type: 'info',
    });

    const error = new Error('copy failed');
    mocks.copyWithUndoAndConflictResolution.mockRejectedValueOnce(error);
    const failed = renderClipboard({
      clipboard: {
        mode: 'copy',
        items: [file('failed.txt')],
        sourcePath: '/source',
      },
    });

    await act(async () => {
      await expect(failed.result.current.handlePaste()).resolves.toBe(true);
    });
    expect(mocks.reportError).toHaveBeenCalledWith('Paste failed', error, {
      toast: failed.props.showToast,
    });
  });

  it('handles global keyboard shortcuts while ignoring editable targets', () => {
    const selected = [file('keyboard.txt')];
    const { result, props, unmount } = renderClipboard({ currentPath: '/source' });
    result.current.getSelectedFilesRef.current = () => selected;

    const copyEvent = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(copyEvent);

    expect(copyEvent.defaultPrevented).toBe(true);
    expect(props.setClipboard).toHaveBeenCalledWith({
      mode: 'copy',
      items: selected,
      sourcePath: '/source',
    });

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'x',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    );

    expect(props.showToast).not.toHaveBeenCalledWith('Cut "keyboard.txt"', { type: 'success' });
    input.remove();
    unmount();
  });
});
