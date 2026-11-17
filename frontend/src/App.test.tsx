import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';
import type { State } from './types';

// The `api/state` shape the backend serves: a `transport` view and no `share` key.
const STATE: State = {
  identity: { fp: 'aaaaaaaa', fingerprint: 'aaaa-aaaa', name: 'Ann', announcedName: null, nameStatus: 'unset' },
  transport: { kind: null, configured: false, dir: null, host: null, port: null, advertise: null, addresses: [], card: null, cardStale: false, error: null, outboxError: null },
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
    expect(screen.getByRole('radio', { name: 'TCP (direct)' })).toBeTruthy();
  });
});
