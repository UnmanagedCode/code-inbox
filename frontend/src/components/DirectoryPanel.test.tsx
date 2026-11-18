import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DirectoryPanel } from './DirectoryPanel';
import type { DirectoryEntry, State } from '../types';

const BOB = 'b'.repeat(64);
const entry = (d: Partial<DirectoryEntry>): DirectoryEntry => ({ fp: BOB, fingerprint: 'bbbb bbbb', name: 'bob', contact: true, presence: [], ...d });
const stateWith = (directory: DirectoryEntry[]) => ({ directory, sharedInboxes: [] }) as unknown as State;

afterEach(() => vi.restoreAllMocks());

describe('DirectoryPanel', () => {
  // Invariant: a stranger is listed with where it is and a "not a contact" tag, and can be invited from the list.
  it('lists a stranger with its presence and invites it', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    const refresh = vi.fn();
    render(<DirectoryPanel state={stateWith([entry({ contact: false, presence: [{ via: 'hub', address: 'hub.example:47822' }] })])} refresh={refresh} />);
    expect(screen.getByText('not a contact')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Presence of bob' }).textContent).toContain('hub.example:47822');
    fireEvent.click(screen.getByRole('button', { name: 'Invite to personal inbox' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls).toEqual([{ url: 'api/invites', body: { to: BOB } }]);
  });

  // Invariant: a contact carries no tag, and one with no route says so.
  it('a contact shows no tag and says when it is not connected', () => {
    render(<DirectoryPanel state={stateWith([entry({})])} refresh={() => {}} />);
    expect(screen.queryByText('not a contact')).toBeNull();
    expect(screen.getByRole('status', { name: 'Presence of bob' }).textContent).toBe('not connected');
  });

  // Invariant: a peer-supplied name renders as text, never as markup.
  it('renders a name as text', () => {
    render(<DirectoryPanel state={stateWith([entry({ name: '<b>x</b>' })])} refresh={() => {}} />);
    expect(screen.getByText('<b>x</b>')).toBeTruthy();
    expect(document.querySelector('strong b')).toBeNull();
  });
});
