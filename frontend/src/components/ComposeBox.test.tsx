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
});
