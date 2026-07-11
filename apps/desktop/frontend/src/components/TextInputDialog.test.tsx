import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TextInputDialog } from './TextInputDialog';

describe('TextInputDialog', () => {
  it('blocks invalid values and submits a trimmed valid value', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TextInputDialog
        open
        title="Save search"
        label="Name"
        validate={(value) => (value.length < 2 ? 'Use at least two characters' : null)}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Use at least two characters');

    await user.type(screen.getByLabelText('Name'), '  Docs  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith('Docs');
  });
});
