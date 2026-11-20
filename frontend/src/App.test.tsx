import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import type { State } from './types';

// The `api/state` shape the backend serves: a `transport` view and no `share` key.
const STATE: State = {
  identity: { fp: 'aaaaaaaa', fingerprint: 'aaaa-aaaa', name: 'Ann', announcedName: null, nameStatus: 'unset' },
  transport: { kind: null, configured: false, dir: null, listen: null, listening: null, connections: [], card: null, error: null, outboxError: null },
  directory: [],
  sharedInboxes: [],
  invites: { incoming: [], outgoing: [] },
  joinRequests: { incoming: [], outgoing: [] },
  inboxes: [],
  diagnostics: { rejected: 0, recent: [], hidden: [], pending: 0, outbox: 0 },
  notify: { target: null, watermark: 0, owed: 0, lastDelivery: null, lastError: null, autoStart: null },
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.restoreAllMocks());

describe('App', () => {
  // Invariant: the overview renders end to end against the backend's current state shape (a render error
  // unmounts the whole page, which is what a UI built for an older shape does).
  it('renders the Code Inbox overview, Transport panel included, from the current api/state', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === 'api/state' ? STATE : { sessions: [], target: null, autoStart: null })));
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Code Inbox' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Network' })).toBeTruthy();
  });

  // Invariant: another inbox gets a fresh view: A's unsent draft and A's messages never show in B.
  it('switching inbox shows a fresh composer and history', async () => {
    const A = 'a'.repeat(32);
    const B = 'b'.repeat(32);
    const peer = 'c'.repeat(64);
    const inbox = (id: string, name: string) => ({ id, kind: 'personal', name, owner: null, members: [{ fp: 'aaaaaaaa', name: 'Ann' }, { fp: peer, name }], unread: 0 });
    const state = { ...STATE, inboxes: [inbox(A, 'amy'), inbox(B, 'ben')] } as unknown as State;
    const msg = (id: string, body: string) => ({ id, seq: 1, ts: 1_700_000_000_000, body, sender: { fp: peer, name: 'x' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'api/state') return json(state);
      return json({ inbox: '', messages: url.includes(A) ? [msg('m1', 'only in A')] : [msg('m2', 'only in B')] });
    }));
    window.history.pushState(null, '', `?inbox=${A}`);
    render(<App />);
    await screen.findByText('only in A');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'draft for A' } });
    act(() => { window.history.pushState(null, '', `?inbox=${B}`); window.dispatchEvent(new PopStateEvent('popstate')); });
    await screen.findByText('only in B');
    expect(screen.queryByText('only in A')).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('');
    await waitFor(() => expect(screen.queryByText('only in A')).toBeNull());
    window.history.pushState(null, '', '?');
  });
});
