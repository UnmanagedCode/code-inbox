import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InboxView } from './InboxView';
import type { Inbox, Message, State } from '../types';

const SELF = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const INBOX: Inbox = { id: 'c'.repeat(32), kind: 'personal', name: 'bob', owner: null, members: [{ fp: SELF, name: 'alice' }, { fp: PEER, name: 'bob' }], unread: 0 };
const STATE = { identity: { fp: SELF, fingerprint: '', name: 'alice', announcedName: 'alice', nameStatus: 'shown' }, directory: [] } as unknown as State;
const EVIL = '<img src=x onerror=alert(1)> javascript:alert(1)';

// Invariant: a message the human just sent comes back through the shared list and renders as literal text.
describe('InboxView', () => {
  it("echoes a sent hostile body as literal text from the backend's list", async () => {
    const stored: Message[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        const { body } = JSON.parse(String(init.body));
        stored.push({ id: 'm1', seq: 1, ts: 1_700_000_000_000, body, sender: { fp: SELF, name: 'alice' } });
        return new Response(JSON.stringify({ id: 'm1', inbox: INBOX.id }), { status: 200 });
      }
      expect(url).toBe(`api/inboxes/${INBOX.id}/messages`);
      return new Response(JSON.stringify({ inbox: INBOX.id, messages: stored }), { status: 200 });
    }));
    const { container } = render(<InboxView inbox={INBOX} state={STATE} refresh={() => {}} back={() => {}} />);
    await screen.findByText('No messages yet.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: EVIL } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText(EVIL)).toBeTruthy());
    expect(container.querySelectorAll('img, script, a')).toHaveLength(0);
  });
});
