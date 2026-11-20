import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComposeBox } from './ComposeBox';

const INBOX = 'a'.repeat(32);
type Call = { url: string; init: RequestInit };

// A fetch stub answering every request with `answer`, keeping the calls.
function stubFetch(answer: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    const { status, body } = answer(c);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

const type = (text: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: text } });
const send = () => fireEvent.click(screen.getByRole('button', { name: 'Send' }));
const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;

afterEach(() => vi.restoreAllMocks());

describe('ComposeBox', () => {
  // Invariant: the box posts {body} as JSON to the inbox's relative messages URL, then clears and reports the send.
  it('POSTs {body} to the relative api/inboxes/<id>/messages and clears on success', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { id: 'r1', inbox: INBOX } }));
    const onSent = vi.fn();
    render(<ComposeBox inboxId={INBOX} onSent={onSent} />);
    type('hello there');
    send();
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`api/inboxes/${INBOX}/messages`);
    expect(calls[0].init.method).toBe('POST');
    expect(new Headers(calls[0].init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ body: 'hello there' });
    expect(box().value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Invariant: a refusal never loses what the human typed, and names the refusal code.
  it('keeps the text and shows the code on a refusal', async () => {
    stubFetch(() => ({ status: 409, body: { error: 'this install is not a party or member of that inbox', code: 'NOT_MEMBER' } }));
    const onSent = vi.fn();
    render(<ComposeBox inboxId={INBOX} onSent={onSent} />);
    type('please keep me');
    send();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('NOT_MEMBER');
    expect(box().value).toBe('please keep me');
    expect(onSent).not.toHaveBeenCalled();
  });

  const enter = (init: Record<string, unknown> = {}) => fireEvent.keyDown(box(), { key: 'Enter', ...init });
  const ok = () => stubFetch(() => ({ status: 200, body: { id: 'r' } }));

  // Invariant: plain Enter sends exactly what was typed and suppresses the newline.
  it('Enter sends', async () => {
    const calls = ok();
    const onSent = vi.fn();
    render(<ComposeBox inboxId={INBOX + 'e1'} onSent={onSent} />);
    type('  keep my spaces ');
    expect(enter()).toBe(false);
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([{ body: '  keep my spaces ' }]);
  });

  // Invariant: Shift+Enter is left to the textarea as a newline.
  it('Shift+Enter does not send', () => {
    const calls = ok();
    render(<ComposeBox inboxId={INBOX + 'e2'} onSent={() => {}} />);
    type('a');
    expect(enter({ shiftKey: true })).toBe(true);
    expect(calls).toHaveLength(0);
  });

  // Invariant: Ctrl+Enter and ⌘+Enter still send.
  it('Ctrl+Enter and ⌘+Enter send', async () => {
    const calls = ok();
    const onSent = vi.fn();
    render(<ComposeBox inboxId={INBOX + 'e3'} onSent={onSent} />);
    type('a');
    enter({ ctrlKey: true });
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    type('b');
    enter({ metaKey: true });
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(2));
    expect(calls).toHaveLength(2);
  });

  // Invariant: Enter that confirms an IME composition never sends.
  it('composing Enter does not send', () => {
    const calls = ok();
    render(<ComposeBox inboxId={INBOX + 'e4'} onSent={() => {}} />);
    type('a');
    enter({ isComposing: true });
    expect(calls).toHaveLength(0);
  });

  // Invariant: on a touch (coarse) pointer Enter is a newline; Ctrl+Enter still sends.
  it('touch: Enter is a newline', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} }));
    const calls = ok();
    const onSent = vi.fn();
    render(<ComposeBox inboxId={INBOX + 'e5'} onSent={onSent} />);
    type('a');
    expect(enter()).toBe(true);
    expect(calls).toHaveLength(0);
    enter({ ctrlKey: true });
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(calls).toHaveLength(1);
  });

  // Invariant: whitespace-only text cannot be sent by button or key.
  it('whitespace-only cannot be sent', () => {
    const calls = ok();
    render(<ComposeBox inboxId={INBOX + 'e6'} onSent={() => {}} />);
    type('  \n ');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    enter();
    expect(calls).toHaveLength(0);
  });

  // Invariant: while a send is in flight the button reads Sending… and is disabled, a second Enter posts nothing,
  // and it returns to Send afterwards.
  it('in-flight state', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { posts++; await gate; return new Response(JSON.stringify({ id: 'r' }), { status: 200 }); }));
    render(<ComposeBox inboxId={INBOX + 'e7'} onSent={() => {}} />);
    type('slow');
    enter();
    const busy = await screen.findByRole('button', { name: 'Sending…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    enter();
    expect(posts).toBe(1);
    release();
    await screen.findByRole('button', { name: 'Send' });
  });

  // Invariant: the textarea has focus on open (fine pointer) and again after a successful send.
  it('focus', async () => {
    ok();
    const onSent = vi.fn();
    render(<ComposeBox inboxId={INBOX + 'e8'} onSent={onSent} />);
    expect(document.activeElement).toBe(box());
    (document.activeElement as HTMLElement).blur();
    type('a');
    send();
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  // Invariant: an unsent draft is kept per inbox across remounts; a send clears it.
  it('draft per inbox', async () => {
    ok();
    const A = INBOX + 'dA';
    const B = INBOX + 'dB';
    const first = render(<ComposeBox inboxId={A} onSent={() => {}} />);
    type('draft A');
    first.unmount();
    const again = render(<ComposeBox inboxId={A} onSent={() => {}} />);
    expect(box().value).toBe('draft A');
    again.unmount();
    const other = render(<ComposeBox inboxId={B} onSent={() => {}} />);
    expect(box().value).toBe('');
    other.unmount();
    const sending = render(<ComposeBox inboxId={A} onSent={() => {}} />);
    send();
    await waitFor(() => expect(box().value).toBe(''));
    sending.unmount();
    render(<ComposeBox inboxId={A} onSent={() => {}} />);
    expect(box().value).toBe('');
  });
});
