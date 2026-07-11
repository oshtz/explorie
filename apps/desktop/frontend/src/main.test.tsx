import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: vi.fn(() => null),
  createRoot: vi.fn(),
  getCurrentWindow: vi.fn(),
  render: vi.fn(),
  show: vi.fn(),
}));

vi.mock('react-dom/client', () => ({
  createRoot: mocks.createRoot,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: mocks.getCurrentWindow,
}));

vi.mock('./App', () => ({
  default: mocks.app,
}));

vi.mock('./index.css', () => ({}));

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
};

describe('main entrypoint', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    document.body.innerHTML = '<div id="root"></div>';
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    mocks.createRoot.mockReturnValue({ render: mocks.render });
    mocks.show.mockResolvedValue(undefined);
    mocks.getCurrentWindow.mockReturnValue({ show: mocks.show });
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      })
    );
  });

  it('mounts the app into the root element', async () => {
    await import('./main');

    expect(mocks.createRoot).toHaveBeenCalledWith(document.getElementById('root'));
    expect(mocks.render).toHaveBeenCalledTimes(1);
    const rendered = mocks.render.mock.calls[0]?.[0];
    expect(rendered.type.name).toBe('RootErrorBoundary');
    expect(rendered.props.children).toEqual(expect.objectContaining({ type: mocks.app }));
  }, 10_000);

  it('does not show the native window outside Tauri', async () => {
    await import('./main');

    expect(mocks.getCurrentWindow).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it('shows the native window after first paint when running in Tauri', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    await import('./main');

    expect(requestAnimationFrame).toHaveBeenCalled();
    expect(mocks.getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(mocks.show).toHaveBeenCalledTimes(1);
  });

  it('renders a static fallback when React bootstrap fails', async () => {
    mocks.createRoot.mockImplementation(() => {
      throw new Error('React mount failed');
    });

    await import('./main');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Explorie couldn’t start' })).toBeVisible();
    });
    expect(screen.getByText('React mount failed')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restart Explorie' })).toBeVisible();
  });
});
