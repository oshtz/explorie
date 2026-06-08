import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkspaceTab } from '../store';
import { WorkspaceManager } from './WorkspaceManager';

type StoreState = Record<string, unknown>;

const mocks = vi.hoisted(() => {
  const state = {} as StoreState;
  const useFileStore = (selector?: (state: StoreState) => unknown) =>
    selector ? selector(state) : state;

  return {
    state,
    useFileStore,
    saveWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    renameWorkspace: vi.fn(),
    loadWorkspace: vi.fn(),
    exportWorkspace: vi.fn(),
    importWorkspace: vi.fn(),
    exportAllWorkspaces: vi.fn(),
    importAllWorkspaces: vi.fn(),
  };
});

vi.mock('../store', () => ({
  useFileStore: mocks.useFileStore,
}));

vi.mock('./Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));

function createWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'workspace-1',
    name: 'Design Review',
    createdAt: Date.UTC(2026, 5, 1, 8),
    updatedAt: Date.UTC(2026, 5, 3, 9),
    tabs: [
      { id: 'tab-1', path: '/Users/test/project' },
      { id: 'tab-2', path: '/Users/test/assets' },
    ],
    activeTabId: 'tab-1',
    viewMode: 'list',
    sortKey: 'name',
    sortDir: 'asc',
    showHidden: false,
    filterMode: 'all',
    showPreviewPanel: true,
    gridMinWidth: 140,
    ...overrides,
  };
}

function setStoreState(overrides: StoreState = {}) {
  for (const key of Object.keys(mocks.state)) {
    delete mocks.state[key];
  }

  Object.assign(mocks.state, {
    workspaces: {
      'workspace-1': createWorkspace(),
      'workspace-2': createWorkspace({
        id: 'workspace-2',
        name: 'Older Workspace',
        updatedAt: Date.UTC(2026, 4, 30, 9),
        tabs: [{ id: 'tab-3', path: '/Users/test/archive' }],
      }),
    },
    lastWorkspaceId: 'workspace-1',
    saveWorkspace: mocks.saveWorkspace,
    deleteWorkspace: mocks.deleteWorkspace,
    renameWorkspace: mocks.renameWorkspace,
    loadWorkspace: mocks.loadWorkspace,
    exportWorkspace: mocks.exportWorkspace,
    importWorkspace: mocks.importWorkspace,
    exportAllWorkspaces: mocks.exportAllWorkspaces,
    importAllWorkspaces: mocks.importAllWorkspaces,
    ...overrides,
  });
}

function renderManager(
  overrides: Partial<React.ComponentProps<typeof WorkspaceManager>> = {},
  tabs: WorkspaceTab[] = [
    { id: 'tab-current', path: '/Users/test/current' },
    { id: 'tab-preview', path: '/Users/test/preview' },
  ]
) {
  const onClose = vi.fn();
  const onLoadWorkspace = vi.fn();
  const props = {
    open: true,
    onClose,
    currentTabs: tabs,
    activeTabId: tabs[0]?.id ?? '',
    onLoadWorkspace,
    ...overrides,
  };

  return {
    onClose,
    onLoadWorkspace,
    ...render(<WorkspaceManager {...props} />),
  };
}

function getWorkspaceItem(name: string): HTMLElement {
  const item = screen.getByText(name).closest('div[class*="workspaceItem"]');
  if (!item) {
    throw new Error(`Could not find workspace item for ${name}`);
  }
  return item as HTMLElement;
}

describe('WorkspaceManager', () => {
  const createObjectURL = vi.fn(() => 'blob:workspace');
  const revokeObjectURL = vi.fn();
  let anchorClick: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    setStoreState();
    mocks.loadWorkspace.mockImplementation(
      (id: string) => (mocks.state.workspaces as Record<string, Workspace>)[id]
    );
    mocks.exportWorkspace.mockReturnValue('{"id":"workspace-1"}');
    mocks.exportAllWorkspaces.mockReturnValue('[{"id":"workspace-1"}]');
    mocks.importWorkspace.mockReturnValue(
      createWorkspace({ id: 'workspace-imported', name: 'Imported One' })
    );
    mocks.importAllWorkspaces.mockReturnValue(2);
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    anchorClick = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURL,
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      configurable: true,
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(anchorClick);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not render while closed and shows an empty workspace state', () => {
    const { container, rerender } = renderManager({ open: false });
    expect(container).toBeEmptyDOMElement();

    setStoreState({ workspaces: {} });
    rerender(
      <WorkspaceManager
        open
        onClose={vi.fn()}
        currentTabs={[{ id: 'tab-current', path: '/Users/test/current' }]}
        activeTabId="tab-current"
        onLoadWorkspace={vi.fn()}
      />
    );

    expect(screen.getByRole('dialog', { name: 'Workspace Manager' })).toBeInTheDocument();
    expect(screen.getByText('Saved Workspaces (0)')).toBeInTheDocument();
    expect(
      screen.getByText('No saved workspaces yet. Save your current tab layout above.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export All' })).toBeDisabled();
  });

  it('saves the current workspace with window and sidebar state', async () => {
    const user = userEvent.setup();
    const getWindowState = vi.fn(async () => ({ width: 1200, height: 800, x: 10, y: 20 }));
    const getSidebarState = vi.fn(() => ({ width: 260, collapsed: false }));
    renderManager({ getWindowState, getSidebarState });

    expect(screen.getByText('2 tabs will be saved')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Workspace name...'), ' Current Work ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.saveWorkspace).toHaveBeenCalledWith(
        'Current Work',
        [
          { id: 'tab-current', path: '/Users/test/current' },
          { id: 'tab-preview', path: '/Users/test/preview' },
        ],
        'tab-current',
        { width: 1200, height: 800, x: 10, y: 20 },
        { width: 260, collapsed: false }
      )
    );
    expect(screen.getByPlaceholderText('Workspace name...')).toHaveValue('');
  });

  it('sorts, loads, and closes workspaces from list and shell controls', async () => {
    const user = userEvent.setup();
    const { onClose, onLoadWorkspace, container } = renderManager();

    const names = screen
      .getAllByText(/Design Review|Older Workspace/)
      .map((node) => node.textContent);
    expect(names).toEqual(['Design Review', 'Older Workspace']);

    await user.click(screen.getByText('Design Review'));
    expect(mocks.loadWorkspace).toHaveBeenCalledWith('workspace-1');
    expect(onLoadWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'workspace-1' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    fireEvent.click(screen.getByRole('dialog', { name: 'Workspace Manager' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(container.firstElementChild as Element);
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    await user.click(closeButtons[closeButtons.length - 1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renames and deletes with cancel and confirm flows', async () => {
    const user = userEvent.setup();
    const { container } = renderManager();

    await user.click(within(getWorkspaceItem('Design Review')).getByTitle('Rename'));
    const editInput = screen.getByDisplayValue('Design Review');
    await user.clear(editInput);
    await user.type(editInput, 'Renamed Workspace');
    await user.click(screen.getByTitle('Save'));

    expect(mocks.renameWorkspace).toHaveBeenCalledWith('workspace-1', 'Renamed Workspace');

    await user.click(within(getWorkspaceItem('Design Review')).getByTitle('Rename'));
    fireEvent.keyDown(container.firstElementChild as Element, { key: 'Escape' });
    expect(screen.queryByDisplayValue('Design Review')).not.toBeInTheDocument();

    await user.click(within(getWorkspaceItem('Design Review')).getByTitle('Delete'));
    expect(screen.getByText('Delete "Design Review"?')).toBeInTheDocument();
    fireEvent.keyDown(container.firstElementChild as Element, { key: 'Escape' });
    expect(screen.queryByText('Delete "Design Review"?')).not.toBeInTheDocument();

    await user.click(within(getWorkspaceItem('Design Review')).getByTitle('Delete'));
    await user.click(screen.getByTitle('Confirm delete'));

    expect(mocks.deleteWorkspace).toHaveBeenCalledWith('workspace-1');
  });

  it('exports workspaces and handles import success/error files', async () => {
    const user = userEvent.setup();
    const { container } = renderManager();

    await user.click(within(getWorkspaceItem('Design Review')).getByTitle('Export'));
    expect(mocks.exportWorkspace).toHaveBeenCalledWith('workspace-1');
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchorClick).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:workspace');

    await user.click(screen.getByRole('button', { name: 'Export All' }));
    expect(mocks.exportAllWorkspaces).toHaveBeenCalled();

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: {
        files: [new File(['{"id":"single"}'], 'single.json', { type: 'application/json' })],
      },
    });
    expect(await screen.findByText('Imported "Imported One"')).toBeInTheDocument();
    expect(mocks.importWorkspace).toHaveBeenCalledWith('{"id":"single"}');

    fireEvent.change(fileInput, {
      target: {
        files: [
          new File(['[{"id":"one"},{"id":"two"}]'], 'all.json', { type: 'application/json' }),
        ],
      },
    });
    expect(await screen.findByText('Imported 2 workspaces')).toBeInTheDocument();
    expect(mocks.importAllWorkspaces).toHaveBeenCalledWith('[{"id":"one"},{"id":"two"}]');

    fireEvent.change(fileInput, {
      target: { files: [new File(['not json'], 'bad.json', { type: 'application/json' })] },
    });
    expect(await screen.findByText('Invalid JSON file')).toBeInTheDocument();
  });
});
