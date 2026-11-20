import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InboxView } from './InboxView';
import { NEAR_BOTTOM_PX } from '../useStickToBottom';
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
    fireEvent.click(screen.getByRole('button', { name: /^Members/ }));
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

// happy-dom has no layout: the history region gets fake sizes (50px per message, a 200px viewport) and a clamped
// scrollTop, as browsers clamp. Reloads go through `visibilitychange` (usePoll runs on it) instead of timers.
const ROW = 50;
const peerMsg = (n: number): Message => ({ id: `p${n}`, seq: n, ts: 1_700_000_000_000 + n * 600_000, body: `msg ${n}`, sender: { fp: PEER, name: 'bob' } });
const atLatest = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;

function scrollServer(initial: Message[]) {
  const box = { messages: initial };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      const { body } = JSON.parse(String(init.body));
      box.messages = [...box.messages, { id: `own${box.messages.length}`, seq: box.messages.length + 1, ts: 1_700_100_000_000, body, sender: { fp: SELF, name: 'alice' } }];
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    }
    return new Response(JSON.stringify({ inbox: INBOX.id, messages: box.messages }), { status: 200 });
  }));
  return box;
}

function fakeLayout(el: HTMLElement, rows: () => number) {
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => rows() * ROW });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 200 });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = Math.max(0, Math.min(v, rows() * ROW - 200)); },
  });
}

async function openScrolling(box: { messages: Message[] }) {
  render(<InboxView key={INBOX.id} inbox={INBOX} state={STATE} refresh={() => {}} back={() => {}} />);
  const region = screen.getByRole('region', { name: 'Message history' });
  fakeLayout(region, () => region.querySelectorAll('li').length);
  const reload = () => act(async () => { document.dispatchEvent(new Event('visibilitychange')); await new Promise((r) => setTimeout(r, 0)); });
  await reload();
  return { region, reload, box };
}

const scrollUp = (region: HTMLElement) => { region.scrollTop = 0; fireEvent.scroll(region); };

describe('InboxView scrolling', () => {
  // Invariant: the newest message is visible without scrolling after the first load.
  it('opens at the latest', async () => {
    const { region } = await openScrolling(scrollServer(Array.from({ length: 30 }, (_, i) => peerMsg(i + 1))));
    await waitFor(() => expect(region.querySelectorAll('li')).toHaveLength(30));
    expect(atLatest(region)).toBe(true);
  });

  // Invariant: Loading shows until the first answer; "No messages yet." only for a really empty inbox.
  it('shows Loading, then the empty state', async () => {
    scrollServer([]);
    render(<InboxView inbox={INBOX} state={STATE} refresh={() => {}} back={() => {}} />);
    expect(screen.getByText('Loading messages…')).toBeTruthy();
    expect(screen.queryByText('No messages yet.')).toBeNull();
    await screen.findByText('No messages yet.');
    expect(screen.queryByText('Loading messages…')).toBeNull();
  });

  // Invariant: a reader at the latest stays there when a message arrives.
  it('stays at the latest when a message arrives', async () => {
    const { region, reload, box } = await openScrolling(scrollServer(Array.from({ length: 10 }, (_, i) => peerMsg(i + 1))));
    box.messages = [...box.messages, peerMsg(11)];
    await reload();
    expect(region.querySelectorAll('li')).toHaveLength(11);
    expect(atLatest(region)).toBe(true);
    expect(screen.queryByRole('button', { name: /New messages/ })).toBeNull();
  });

  // Invariant: a scrolled-up reader keeps their place; the button says New messages when something arrived and
  // jumps to the latest on click.
  it('keeps a scrolled-up reader in place', async () => {
    const { region, reload, box } = await openScrolling(scrollServer(Array.from({ length: 10 }, (_, i) => peerMsg(i + 1))));
    scrollUp(region);
    expect(screen.getByRole('button', { name: 'Jump to latest ↓' })).toBeTruthy();
    box.messages = [...box.messages, peerMsg(11)];
    await reload();
    expect(region.scrollTop).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'New messages ↓' }));
    expect(atLatest(region)).toBe(true);
    expect(screen.queryByRole('button', { name: /↓/ })).toBeNull();
  });

  // Invariant: a poll that returns the same list neither moves the reader nor flags new messages.
  it('an unchanged poll does not move or flag', async () => {
    const { region, reload } = await openScrolling(scrollServer(Array.from({ length: 10 }, (_, i) => peerMsg(i + 1))));
    scrollUp(region);
    await reload();
    expect(region.scrollTop).toBe(0);
    expect(screen.queryByRole('button', { name: 'New messages ↓' })).toBeNull();
  });

  // Invariant: the human's own send jumps to the latest even when scrolled up.
  it('own send jumps to the latest', async () => {
    const { region } = await openScrolling(scrollServer(Array.from({ length: 10 }, (_, i) => peerMsg(i + 1))));
    scrollUp(region);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'my reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(region.querySelectorAll('li')).toHaveLength(11));
    await waitFor(() => expect(atLatest(region)).toBe(true));
  });

  // Invariant: the composer is outside the scrolling history and follows it (the structural half of "pinned").
  it('composer sits outside the history', async () => {
    scrollServer([]);
    render(<InboxView inbox={INBOX} state={STATE} refresh={() => {}} back={() => {}} />);
    const region = screen.getByRole('region', { name: 'Message history' });
    const textbox = screen.getByRole('textbox', { name: 'Message' });
    expect(region.contains(textbox)).toBe(false);
    const form = textbox.closest('form')!;
    expect(region.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await screen.findByText('No messages yet.');
  });

  // Invariant: the member list hides behind a toggle that reports its state.
  it('members toggle', async () => {
    scrollServer([]);
    render(<InboxView inbox={INBOX} state={STATE} refresh={() => {}} back={() => {}} />);
    const toggle = screen.getByRole('button', { name: 'Members (2)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/bob \[/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/bob \[/)).toBeTruthy();
    await screen.findByText('No messages yet.');
  });

  // Invariant: the own send jumps to the latest even when a poll delivered the sent message before the POST
  // resolved (no later newest-message change would come to scroll).
  it('own send jumps to the latest when a poll lands first', async () => {
    const box = { messages: Array.from({ length: 10 }, (_, i) => peerMsg(i + 1)) };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        box.messages = [...box.messages, { id: 'own', seq: 11, ts: 1_700_100_000_000, body: 'mine', sender: { fp: SELF, name: 'alice' } }];
        await gate;
        return new Response(JSON.stringify({ id: 'own' }), { status: 200 });
      }
      return new Response(JSON.stringify({ inbox: INBOX.id, messages: box.messages }), { status: 200 });
    }));
    const { region, reload } = await openScrolling(box);
    scrollUp(region);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await reload();
    expect(region.querySelectorAll('li')).toHaveLength(11);
    expect(region.scrollTop).toBe(0);
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(atLatest(region)).toBe(true));
  });

  // Invariant: "New messages" is cleared by the jump button and by the reader reaching the bottom, so a later
  // scroll up with no traffic offers "Jump to latest" again.
  it('the fresh flag resets on jump and on reaching the bottom', async () => {
    const { region, reload, box } = await openScrolling(scrollServer(Array.from({ length: 10 }, (_, i) => peerMsg(i + 1))));
    scrollUp(region);
    box.messages = [...box.messages, peerMsg(11)];
    await reload();
    fireEvent.click(screen.getByRole('button', { name: 'New messages ↓' }));
    scrollUp(region);
    expect(screen.getByRole('button', { name: 'Jump to latest ↓' })).toBeTruthy();
    box.messages = [...box.messages, peerMsg(12)];
    await reload();
    expect(screen.getByRole('button', { name: 'New messages ↓' })).toBeTruthy();
    region.scrollTop = region.scrollHeight;
    fireEvent.scroll(region);
    expect(screen.queryByRole('button', { name: /↓/ })).toBeNull();
    scrollUp(region);
    expect(screen.getByRole('button', { name: 'Jump to latest ↓' })).toBeTruthy();
  });

  // Invariant: a scroll event that comes with a viewport-height change (the browser clamping after the header or
  // composer resized) is not read as the reader leaving the latest; the resize re-pin keeps them at the latest.
  it('a layout-driven resize plus scroll keeps a reader at the latest pinned', async () => {
    let resized: () => void = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { resized = cb; } observe() {} disconnect() {} });
    const box = scrollServer(Array.from({ length: 10 }, (_, i) => peerMsg(i + 1)));
    const { region } = await openScrolling(box);
    let height = 200;
    Object.defineProperty(region, 'clientHeight', { configurable: true, get: () => height });
    let top = region.scrollTop;
    Object.defineProperty(region, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => { top = Math.max(0, Math.min(v, region.scrollHeight - height)); },
    });
    act(() => resized()); // the observer's initial notification: judge scrolls against the current height
    expect(atLatest(region)).toBe(true);
    height = 100; // e.g. the header grew
    fireEvent.scroll(region); // the browser's scroll event for the changed layout
    act(() => resized());
    expect(atLatest(region)).toBe(true);
    expect(screen.queryByRole('button', { name: /↓/ })).toBeNull();
  });
});
