import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfirmButton } from './ConfirmButton';

describe('ConfirmButton', () => {
  // Invariant: a destructive action needs two clicks: the first only asks, Cancel sends nothing, Confirm acts once.
  it('a first click posts nothing; Cancel posts nothing; Confirm posts once', () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton label="Delete" confirmLabel="Confirm delete" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Confirm delete' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Confirm delete' })).toBeNull();
  });

  // Invariant: a disabled control cannot start the confirm step.
  it('a disabled button asks nothing', () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton label="Delete" confirmLabel="Confirm delete" disabled onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.queryByRole('button', { name: 'Confirm delete' })).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
