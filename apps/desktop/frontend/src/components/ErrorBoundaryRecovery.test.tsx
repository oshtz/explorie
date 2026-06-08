import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, InlineErrorBoundary } from './ErrorBoundary';
import { RecoveryBanner } from './RecoveryBanner';

function ExplodingChild({ shouldThrow }: { shouldThrow: () => boolean }) {
  if (shouldThrow()) {
    throw new Error('Preview crashed');
  }
  return <div>Recovered content</div>;
}

describe('ErrorBoundary components', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the default fallback, reports the error, and retries rendering', async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    let shouldThrow = true;

    render(
      <ErrorBoundary name="Preview" onError={onError}>
        <ExplodingChild shouldThrow={() => shouldThrow} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Preview crashed')).toBeInTheDocument();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error)).toHaveBeenCalled();

    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
  });

  it('uses custom fallback content when provided', () => {
    render(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <ExplodingChild shouldThrow={() => true} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Custom fallback')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('shows inline fallback and retries inline content', async () => {
    const user = userEvent.setup();
    let shouldThrow = true;

    render(
      <InlineErrorBoundary>
        <ExplodingChild shouldThrow={() => shouldThrow} />
      </InlineErrorBoundary>
    );

    expect(screen.getByText('Error loading content')).toBeInTheDocument();

    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
  });
});

describe('RecoveryBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00Z'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('summarizes recoverable session details and dispatches actions', async () => {
    const onRecover = vi.fn();
    const onDismiss = vi.fn();

    render(
      <RecoveryBanner
        tabCount={2}
        lastSaveAt={new Date('2026-06-03T11:55:00Z')}
        lastPath="C:/work/explorie"
        onRecover={onRecover}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByText('Restore previous session?')).toBeInTheDocument();
    expect(screen.getByText('2 tabs')).toBeInTheDocument();
    expect(screen.getByText('Last: explorie')).toBeInTheDocument();
    expect(screen.getByText('Saved 5 minutes ago')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.click(screen.getByRole('button', { name: /restore/i }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onRecover).toHaveBeenCalledTimes(1);
  });
});
