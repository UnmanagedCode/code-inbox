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

const TEAM: Inbox = { id: 'e'.repeat(32), kind: 'shared', name: 'team', owner: { fp: SELF, name: 'alice' }, members: [{ fp: SELF, name: 'alice' }, { fp: PEER, name: 'bob' }], unread: 0 };
const CAROL = 'f'.repeat(64);
const DAVE = '9'.repeat(64);
const dir = (fp: string, name: string) => ({ fp, fingerprint: '', name, contact: true, presence: [] });
const ownerState = {
  ...STATE,
  directory: [dir(PEER, 'bob'), dir(CAROL, 'carol'), dir(DAVE, 'dave')],
  invites: { incoming: [], outgoing: [{ id: '1'.repeat(32), kind: 'shared', inbox: TEAM.id, inboxName: 'team', from: { fp: SELF, name: 'alice' }, to: { fp: CAROL, name: 'carol' }, ts: 1 }] },
} as unknown as State;

// Serves an empty message list and records every POST; `refuse` answers POSTs with that refusal.
function server(refuse?: { code: string; error: string }) {
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method !== 'POST') return new Response(JSON.stringify({ inbox: '', messages: [] }), { status: 200 });
    posts.push(url);
    return refuse ? new Response(JSON.stringify(refuse), { status: 409 }) : new Response(JSON.stringify({ id: 'x' }), { status: 200 });
  }));
  return posts;
}

describe('InboxView closing', () => {
  // Invariant: the header offers the one closing action the human's role allows (owner Delete inbox, member Leave
  // inbox, personal Revoke), posts its route after the confirm step and goes back to the list on success.
  it('header action by kind and role posts the right route and goes back', async () => {
    const member = { ...TEAM, owner: { fp: PEER, name: 'bob' } };
    const cases: [Inbox, string, string, string][] = [
      [TEAM, 'Delete inbox', 'Confirm delete', `api/inboxes/${TEAM.id}/delete`],
      [member, 'Leave inbox', 'Confirm leave', `api/inboxes/${TEAM.id}/leave`],
      [INBOX, 'Revoke', 'Confirm revoke', `api/inboxes/${INBOX.id}/delete`],
    ];
    for (const [inbox, label, confirm, url] of cases) {
      const posts = server();
      const back = vi.fn();
      const { unmount } = render(<InboxView inbox={inbox} state={ownerState} refresh={() => {}} back={back} />);
      await screen.findByText('No messages yet.');
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(posts).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: confirm }));
      await waitFor(() => expect(back).toHaveBeenCalled());
      expect(posts).toEqual([url]);
      unmount();
    }
  });

  // Invariant: a refused closing stays on the inbox and shows "CODE: message".
  it('a refusal shows CODE: message and stays', async () => {
    server({ code: 'NOT_MEMBER', error: 'not a member' });
    const back = vi.fn();
    render(<InboxView inbox={INBOX} state={ownerState} refresh={() => {}} back={back} />);
    await screen.findByText('No messages yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('NOT_MEMBER: not a member'));
    expect(back).not.toHaveBeenCalled();
  });

  // Invariant: the owner's control follows the chosen party: a member is Revoked (removed), an identity with an open
  // invite shows a disabled Invite pending, anyone else is Invited.
  it('OwnerControls: member → Revoke, invited → Invite pending, other → Invite', async () => {
    const posts = server();
    render(<InboxView inbox={TEAM} state={ownerState} refresh={() => {}} back={() => {}} />);
    await screen.findByText('No messages yet.');
    const select = screen.getByRole('combobox');
    const options = [...select.querySelectorAll('option')].map((o) => o.value).filter(Boolean).sort();
    expect(options).toEqual([PEER, CAROL, DAVE].sort());
    fireEvent.change(select, { target: { value: PEER } });
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => expect(posts).toEqual([`api/inboxes/${TEAM.id}/members/${PEER}/remove`]));
    fireEvent.change(select, { target: { value: CAROL } });
    const pending = screen.getByRole('button', { name: 'Invite pending' }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.change(select, { target: { value: DAVE } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    await waitFor(() => expect(posts).toEqual([`api/inboxes/${TEAM.id}/members/${PEER}/remove`, `api/inboxes/${TEAM.id}/invites`]));
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});
