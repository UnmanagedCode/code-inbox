import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContactsPanel } from './ContactsPanel';
import type { State, TransportView } from '../types';

const CARD = 'code-inbox-card:v1:abc';
const tcp = (t: Partial<TransportView> = {}) => ({
  transport: { kind: 'tcp', configured: true, dir: null, host: '127.0.0.1', port: 47821, advertise: '127.0.0.1', addresses: [], card: CARD, cardStale: false, error: null, ...t },
}) as unknown as State;

afterEach(() => vi.restoreAllMocks());

describe('ContactsPanel', () => {
  // Invariant: Import posts the pasted card to the relative api/contacts and names the refusal code.
  it('Import posts the pasted card and shows the refusal code', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ error: 'not a contact card', code: 'CARD_INVALID' }), { status: 400 });
    }));
    render(<ContactsPanel state={tcp()} refresh={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Contact card' }), { target: { value: 'pasted' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('CARD_INVALID');
    expect(calls).toEqual([{ url: 'api/contacts', body: { card: 'pasted' } }]);
  });

  // Invariant: Copy puts exactly the install's card on the clipboard.
  it('Copy writes the card to the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ContactsPanel state={tcp()} refresh={() => {}} />);
    expect((screen.getByRole('textbox', { name: 'Your contact card' }) as HTMLTextAreaElement).value).toBe(CARD);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CARD));
  });

  // Invariant: with no card yet there is nothing to copy.
  it('without a card, Copy is disabled', () => {
    render(<ContactsPanel state={tcp({ card: null })} refresh={() => {}} />);
    expect((screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
