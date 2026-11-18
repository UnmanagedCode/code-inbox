import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DirectoryPanel } from './DirectoryPanel';
import type { DirectoryEntry, Inbox, Invite, SharedInbox, State } from '../types';

const SELF = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const TEAM = 'c'.repeat(32);
const PERSONAL = 'd'.repeat(32);
const entry = (d: Partial<DirectoryEntry>): DirectoryEntry => ({ fp: BOB, fingerprint: 'bbbb bbbb', name: 'bob', contact: true, presence: [], ...d });
const stateWith = (directory: DirectoryEntry[], more: Partial<State> = {}) => ({
  identity: { fp: SELF }, directory, sharedInboxes: [], inboxes: [], invites: { incoming: [], outgoing: [] }, ...more,
}) as unknown as State;
const shared = (s: Partial<SharedInbox>): SharedInbox => ({ id: TEAM, name: 'team', owner: { fp: SELF, name: 'alice' }, memberCount: 2, isMember: false, isOwner: false, requestPending: false, ...s });
const personalInbox: Inbox = { id: PERSONAL, kind: 'personal', name: 'bob', owner: null, members: [{ fp: SELF, name: 'alice' }, { fp: BOB, name: 'bob' }], unread: 0 };
const personalInvite = (from: string, to: string): Invite => ({ id: 'e'.repeat(32), kind: 'personal', inbox: PERSONAL, inboxName: null, from: { fp: from, name: null }, to: { fp: to, name: null }, ts: 1 });

// Records every POST the panel makes.
function spyPosts() {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({}), { status: 200 });
  }));
  return calls;
}
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

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

  // Invariant: a shared inbox row offers exactly the action its state allows: the owner Deletes, a member Leaves (each
  // after a confirm step), an open request is a disabled Request pending, anyone else may Request to join.
  it('each shared row state posts its own route', async () => {
    const cases: [Partial<SharedInbox>, string[], string | null][] = [
      [{ isOwner: true, isMember: true }, ['Delete', 'Confirm delete'], `api/inboxes/${TEAM}/delete`],
      [{ isMember: true }, ['Leave', 'Confirm leave'], `api/inboxes/${TEAM}/leave`],
      [{}, ['Request to join'], `api/inboxes/${TEAM}/join`],
    ];
    for (const [s, clicks, url] of cases) {
      const calls = spyPosts();
      const refresh = vi.fn();
      const { unmount } = render(<DirectoryPanel state={stateWith([], { sharedInboxes: [shared(s)] })} refresh={refresh} />);
      for (const name of clicks) click(name);
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      expect(calls.map((c) => c.url)).toEqual([url]);
      unmount();
    }
    const calls = spyPosts();
    render(<DirectoryPanel state={stateWith([], { sharedInboxes: [shared({ requestPending: true })] })} refresh={() => {}} />);
    const pending = screen.getByRole('button', { name: 'Request pending' }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(calls).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Request to join' })).toBeNull();
  });

  // Invariant: an identity row follows the personal inbox with it: Revoke once accepted, a disabled Invite pending
  // while an invite is open either way, else Invite.
  it('each identities row state posts its own route', async () => {
    let calls = spyPosts();
    const refresh = vi.fn();
    const { unmount } = render(<DirectoryPanel state={stateWith([entry({})], { inboxes: [personalInbox] })} refresh={refresh} />);
    expect(screen.queryByRole('button', { name: 'Invite to personal inbox' })).toBeNull();
    click('Revoke');
    click('Confirm revoke');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls.map((c) => c.url)).toEqual([`api/inboxes/${PERSONAL}/delete`]);
    unmount();
    for (const invites of [{ incoming: [personalInvite(BOB, SELF)], outgoing: [] }, { incoming: [], outgoing: [personalInvite(SELF, BOB)] }]) {
      calls = spyPosts();
      const r = render(<DirectoryPanel state={stateWith([entry({})], { invites } as Partial<State>)} refresh={() => {}} />);
      const pending = screen.getByRole('button', { name: 'Invite pending' }) as HTMLButtonElement;
      expect(pending.disabled).toBe(true);
      fireEvent.click(pending);
      expect(calls).toEqual([]);
      r.unmount();
    }
  });
});
