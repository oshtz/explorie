import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canRecover,
  clearSessionState,
  getDirtyTimestamp,
  getRecoveryInfo,
  getSessionState,
  markSessionClean,
  markSessionDirty,
  saveSessionState,
  SessionManager,
  wasSessionDirty,
  type SessionState,
} from './crashRecovery';

function readStoredState(): SessionState {
  const raw = localStorage.getItem('explorie:sessionState');
  if (!raw) throw new Error('expected stored session state');
  return JSON.parse(raw) as SessionState;
}

describe('crashRecovery', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('saves session state with defaults and merges partial updates', () => {
    expect(getSessionState()).toBeNull();
    expect(saveSessionState({ tabs: [{ id: 'one', path: '/one' }], currentPath: '/one' })).toBe(
      true
    );

    const first = readStoredState();
    expect(first.startedAt).toBe(Date.now());
    expect(first.lastSaveAt).toBe(Date.now());
    expect(first.tabs).toEqual([{ id: 'one', path: '/one' }]);
    expect(first.currentPath).toBe('/one');
    expect(first.viewSettings).toEqual({
      viewMode: 'list',
      sortKey: 'name',
      sortDir: 'asc',
      showHidden: false,
    });

    vi.setSystemTime(new Date('2026-06-03T10:05:00.000Z'));
    expect(saveSessionState({ activeTabId: 'one' })).toBe(true);

    expect(getSessionState()).toMatchObject({
      startedAt: first.startedAt,
      activeTabId: 'one',
      currentPath: '/one',
      tabs: [{ id: 'one', path: '/one' }],
    });
    expect(getSessionState()?.lastSaveAt).toBe(Date.now());
  });

  it('handles dirty-session markers and invalid stored values', () => {
    expect(wasSessionDirty()).toBe(false);
    expect(markSessionDirty()).toBe(true);
    expect(wasSessionDirty()).toBe(true);
    expect(getDirtyTimestamp()).toBe(Date.now());

    localStorage.setItem('explorie:sessionDirty', 'not-a-number');
    expect(getDirtyTimestamp()).toBeNull();

    expect(markSessionClean()).toBe(true);
    expect(wasSessionDirty()).toBe(false);

    localStorage.setItem('explorie:sessionState', '{bad json');
    expect(getSessionState()).toBeNull();
  });

  it('offers recovery only for recent dirty sessions with recoverable state', () => {
    expect(saveSessionState({ tabs: [{ id: 'tab-1', path: '/work' }], currentPath: '/work' })).toBe(
      true
    );
    expect(canRecover()).toBe(false);

    expect(markSessionDirty()).toBe(true);
    expect(canRecover()).toBe(true);
    expect(getRecoveryInfo()).toMatchObject({
      available: true,
      tabCount: 1,
      pendingOpCount: 0,
      currentPath: '/work',
    });
    expect(getRecoveryInfo().lastSaveAt?.getTime()).toBe(Date.now());

    vi.setSystemTime(new Date('2026-06-05T10:00:01.000Z'));
    expect(canRecover()).toBe(false);
    expect(getRecoveryInfo()).toMatchObject({
      available: false,
      tabCount: 1,
      currentPath: '/work',
    });
  });

  it('offers recovery for pending operations even without tabs', () => {
    expect(
      saveSessionState({
        tabs: [],
        pendingOperations: [
          {
            id: 'op-1',
            type: 'copy',
            status: 'running',
            paths: ['/source'],
            destination: '/dest',
          },
        ],
      })
    ).toBe(true);
    markSessionDirty();

    expect(canRecover()).toBe(true);
    expect(getRecoveryInfo()).toMatchObject({
      available: true,
      tabCount: 0,
      pendingOpCount: 1,
    });
  });

  it('clears session state and dirty markers', () => {
    saveSessionState({ tabs: [{ id: 'tab-1', path: '/work' }] });
    markSessionDirty();

    expect(clearSessionState()).toBe(true);

    expect(localStorage.getItem('explorie:sessionState')).toBeNull();
    expect(localStorage.getItem('explorie:sessionDirty')).toBeNull();
    expect(getSessionState()).toBeNull();
  });

  it('session manager initializes, autosaves, handles unload, and shuts down cleanly', () => {
    const manager = new SessionManager();
    const getState = vi
      .fn()
      .mockReturnValueOnce({
        tabs: [{ id: 'initial', path: '/initial' }],
        activeTabId: 'initial',
        currentPath: '/initial',
      })
      .mockReturnValue({
        tabs: [{ id: 'updated', path: '/updated' }],
        activeTabId: 'updated',
        currentPath: '/updated',
      });

    manager.initialize(getState);

    expect(wasSessionDirty()).toBe(true);
    expect(readStoredState()).toMatchObject({
      tabs: [{ id: 'initial', path: '/initial' }],
      activeTabId: 'initial',
      currentPath: '/initial',
    });

    vi.advanceTimersByTime(30_000);
    expect(readStoredState()).toMatchObject({
      tabs: [{ id: 'updated', path: '/updated' }],
      activeTabId: 'updated',
      currentPath: '/updated',
    });

    markSessionDirty();
    window.dispatchEvent(new Event('beforeunload'));
    expect(wasSessionDirty()).toBe(false);

    markSessionDirty();
    window.dispatchEvent(new Event('pagehide'));
    expect(wasSessionDirty()).toBe(false);

    markSessionDirty();
    manager.shutdown();
    expect(wasSessionDirty()).toBe(false);
    expect(getState).toHaveBeenCalled();
  });

  it('session manager ignores duplicate initialize calls and can dismiss recovery', () => {
    const manager = new SessionManager();
    const getState = vi.fn(() => ({
      tabs: [{ id: 'tab-1', path: '/work' }],
      activeTabId: 'tab-1',
      currentPath: '/work',
    }));

    manager.initialize(getState);
    manager.initialize(() => ({ currentPath: '/ignored' }));

    expect(getState).toHaveBeenCalledTimes(1);
    expect(readStoredState().currentPath).toBe('/work');

    manager.dismissRecovery();
    expect(getSessionState()).toBeNull();
    expect(wasSessionDirty()).toBe(false);

    manager.shutdown();
  });
});
