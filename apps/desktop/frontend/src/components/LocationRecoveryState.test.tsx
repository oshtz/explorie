import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderLoadErrorState, StartupLocationState } from './LocationRecoveryState';

describe('LocationRecoveryState', () => {
  afterEach(cleanup);

  it('offers folder selection, manual entry, and location retry when startup is blocked', async () => {
    const user = userEvent.setup();
    const onChooseFolder = vi.fn();
    const onEnterPath = vi.fn();
    const onRetryInitialization = vi.fn();

    render(
      <StartupLocationState
        initializationError="System locations unavailable"
        choosingFolder={false}
        pickerError={null}
        onChooseFolder={onChooseFolder}
        onEnterPath={onEnterPath}
        onRetryInitialization={onRetryInitialization}
      />
    );

    expect(screen.getByRole('heading', { name: 'Choose a folder to get started' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Choose folder' }));
    await user.click(screen.getByRole('button', { name: 'Enter a path' }));
    await user.click(screen.getByRole('button', { name: 'Retry locations' }));

    expect(onChooseFolder).toHaveBeenCalledTimes(1);
    expect(onEnterPath).toHaveBeenCalledTimes(1);
    expect(onRetryInitialization).toHaveBeenCalledTimes(1);
  });

  it('shows folder details and both recovery actions after a load failure', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onChooseFolder = vi.fn();

    render(
      <FolderLoadErrorState
        path={'Z:\\missing'}
        error="The system cannot find the path specified"
        choosingFolder={false}
        pickerError="Dialog unavailable"
        onRetry={onRetry}
        onChooseFolder={onChooseFolder}
      />
    );

    expect(screen.getByText('Z:\\missing')).toBeVisible();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await user.click(screen.getByRole('button', { name: 'Choose another folder' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onChooseFolder).toHaveBeenCalledTimes(1);
  });
});
