import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugPanel } from './DebugPanel';

type MockState = Record<string, unknown>;
type Selector = (state: MockState) => unknown;
type ErrorReportStub = {
  id: string;
  timestamp: string;
  operation: string;
  error: { message: string; category: string };
};
type StoreMock = (selector?: Selector) => unknown;
type MockFn = ReturnType<typeof vi.fn>;
type DebugPanelMocks = {
  fileState: MockState;
  undoState: MockState;
  operationState: MockState;
  useFileStore: StoreMock;
  useUndoRedoStore: StoreMock;
  useOperationQueueStore: StoreMock;
  errorReports: ErrorReportStub[];
  getErrorReports: MockFn;
  clearErrorReports: MockFn;
  exportErrorReports: MockFn;
  getLogBuffer: MockFn;
  copyDiagnosticsJson: MockFn;
  downloadDiagnosticsJson: MockFn;
};

const mocks = vi.hoisted(() => {
  const fileState = {} as MockState;
  const undoState = {} as MockState;
  const operationState = {} as MockState;
  const data = {
    fileState,
    undoState,
    operationState,
    useFileStore: undefined as unknown as StoreMock,
    useUndoRedoStore: undefined as unknown as StoreMock,
    useOperationQueueStore: undefined as unknown as StoreMock,
    errorReports: [] as ErrorReportStub[],
    getErrorReports: vi.fn(),
    clearErrorReports: vi.fn(),
    exportErrorReports: vi.fn(),
    getLogBuffer: vi.fn(),
    copyDiagnosticsJson: vi.fn(),
    downloadDiagnosticsJson: vi.fn(),
  } satisfies DebugPanelMocks;

  const makeStore = (state: MockState) => (selector?: Selector) =>
    selector ? selector(state) : state;

  data.useFileStore = makeStore(fileState);
  data.useUndoRedoStore = makeStore(undoState);
  data.useOperationQueueStore = makeStore(operationState);
  data.getErrorReports.mockImplementation(() => data.errorReports);
  data.clearErrorReports.mockImplementation(() => {
    data.errorReports = [];
  });
  data.exportErrorReports.mockReturnValue('{"reports":[]}');

  return data;
});

vi.mock('../store', () => ({
  useFileStore: mocks.useFileStore,
}));

vi.mock('../undoRedoStore', () => ({
  useUndoRedoStore: mocks.useUndoRedoStore,
}));

vi.mock('../operationQueueStore', () => ({
  useOperationQueueStore: mocks.useOperationQueueStore,
}));

vi.mock('../utils/errorReporter', () => ({
  getErrorReports: mocks.getErrorReports,
  clearErrorReports: mocks.clearErrorReports,
  exportErrorReports: mocks.exportErrorReports,
}));

vi.mock('../utils/logger', () => ({
  logger: {
    getBuffer: mocks.getLogBuffer,
  },
}));

vi.mock('../utils/diagnosticsReport', () => ({
  copyDiagnosticsJson: mocks.copyDiagnosticsJson,
  downloadDiagnosticsJson: mocks.downloadDiagnosticsJson,
}));

function assignState(target: MockState, source: MockState) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}

function createOperation(overrides: MockState = {}) {
  return {
    id: 'op-1',
    type: 'copy',
    status: 'running',
    totalBytes: 100,
    processedBytes: 50,
    error: 'one failed item',
    ...overrides,
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof DebugPanel>> = {}) {
  const onClose = vi.fn();
  const props = {
    open: true,
    onClose,
    ...overrides,
  };

  return {
    onClose,
    ...render(<DebugPanel {...props} />),
  };
}

describe('DebugPanel', () => {
  const createObjectURL = vi.fn(() => 'blob:debug');
  const revokeObjectURL = vi.fn();
  let anchorClick: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mocks.getErrorReports.mockReset();
    mocks.getErrorReports.mockImplementation(() => mocks.errorReports);
    mocks.clearErrorReports.mockReset();
    mocks.clearErrorReports.mockImplementation(() => {
      mocks.errorReports = [];
    });
    mocks.exportErrorReports.mockReset();
    mocks.exportErrorReports.mockReturnValue('{"reports":[]}');
    mocks.getLogBuffer.mockReset();
    mocks.copyDiagnosticsJson.mockReset();
    mocks.copyDiagnosticsJson.mockResolvedValue('{"app":{"version":"0.1.0"}}\n');
    mocks.downloadDiagnosticsJson.mockReset();
    mocks.downloadDiagnosticsJson.mockReturnValue('{"app":{"version":"0.1.0"}}\n');
    assignState(mocks.fileState, {
      pathStack: ['/Users/test'],
      files: [{ id: 'file-1', name: 'notes.txt' }],
      loading: false,
      error: 'Load warning',
      viewMode: 'list',
      theme: 'dark',
      clipboard: {
        mode: 'copy',
        sourcePath: '/Users/test',
        items: [
          { id: 'file-1', name: 'notes.txt' },
          { id: 'file-2', name: 'image.png' },
        ],
      },
      favorites: [{ path: '/Users/test', name: 'test' }],
      activeSmartFolderId: 'smart-1',
    });
    assignState(mocks.undoState, {
      undoStack: [{ id: 'undo-1' }],
      redoStack: [{ id: 'redo-1' }, { id: 'redo-2' }],
    });
    assignState(mocks.operationState, {
      operations: [createOperation()],
      hasActiveOperations: () => true,
    });
    mocks.errorReports = [
      {
        id: 'err-1',
        timestamp: '2026-06-03T09:00:00.000Z',
        operation: 'Read file',
        error: { message: 'Permission denied', category: 'Access' },
      },
    ];
    mocks.getLogBuffer.mockReturnValue([
      {
        timestamp: '2026-06-03T09:01:00.000Z',
        levelName: 'INFO',
        message: 'Loaded folder',
      },
    ]);
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

  it('does not render while closed', () => {
    const { container } = renderPanel({ open: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders state sections, toggles details, exports state, and closes from the shell', async () => {
    const user = userEvent.setup();
    const { onClose, container } = renderPanel();

    expect(screen.getByText('Debug Panel')).toBeInTheDocument();
    expect(screen.getByText('/Users/test')).toBeInTheDocument();
    expect(screen.getByText('Load warning')).toBeInTheDocument();
    expect(screen.getByText('Clipboard (2 items)')).toBeInTheDocument();

    await user.click(screen.getByText('View'));
    expect(screen.getByText('View Mode:')).toBeInTheDocument();
    expect(screen.getByText('list')).toBeInTheDocument();

    await user.click(screen.getByText('Export State'));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchorClick).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:debug');

    fireEvent.click(screen.getByText('Debug Panel'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(container.firstElementChild as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows operation progress and errors on the operations tab', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Operations (1)' }));

    expect(screen.getByText('copy')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText(/Progress:\s*50%/)).toBeInTheDocument();
    expect(screen.getByText('one failed item')).toBeInTheDocument();
  });

  it('refreshes, clears, and exports collected error reports', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Errors (0)' }));

    expect(mocks.getErrorReports).toHaveBeenCalled();
    expect(screen.getByText('Read file')).toBeInTheDocument();
    expect(screen.getByText('Permission denied')).toBeInTheDocument();
    expect(screen.getByText('Category: Access')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(mocks.exportErrorReports).toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));

    await user.click(screen.getByRole('button', { name: 'Clear All' }));
    await waitFor(() => expect(mocks.clearErrorReports).toHaveBeenCalled());
    expect(screen.getByText('No error reports collected')).toBeInTheDocument();
  });

  it('renders recent logs and empty operation state', async () => {
    const user = userEvent.setup();
    assignState(mocks.operationState, {
      operations: [],
      hasActiveOperations: () => false,
    });
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Operations (0)' }));
    expect(screen.getByText('No active operations')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Logs' }));
    expect(screen.getByText('[INFO]')).toBeInTheDocument();
    expect(screen.getByText('Loaded folder')).toBeInTheDocument();
  });

  it('copies and downloads redacted diagnostics from the diagnostics tab', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Diagnostics' }));
    await user.click(screen.getByRole('button', { name: 'Copy diagnostics JSON' }));

    await waitFor(() => expect(mocks.copyDiagnosticsJson).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Diagnostics copied')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Download diagnostics JSON' }));

    expect(mocks.downloadDiagnosticsJson).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Diagnostics downloaded')).toBeInTheDocument();
  });
});
