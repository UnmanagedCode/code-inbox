import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TransportPanel, isLoopback, isWildcard } from './TransportPanel';
import type { State, TransportView } from '../types';

const NONE: TransportView = { kind: null, configured: false, dir: null, host: null, port: null, advertise: null, url: null, hub: null, addresses: [], card: null, cardStale: false, error: null, outboxError: null };
const stateWith = (transport: Partial<TransportView> = {}, outbox = 0) => ({ transport: { ...NONE, ...transport }, diagnostics: { outbox } }) as unknown as State;

function stubFetch() {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({}), { status: 200 });
  }));
  return calls;
}

const field = (name: string) => screen.getByRole('textbox', { name });
const type = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });

afterEach(() => vi.restoreAllMocks());

describe('TransportPanel', () => {
  // Invariant: the TCP form posts exactly what the human entered to the relative api/tcp.
  it('choosing TCP posts api/tcp with the entered host, port and advertise', async () => {
    const calls = stubFetch();
    const refresh = vi.fn();
    render(<TransportPanel state={stateWith()} refresh={refresh} />);
    fireEvent.click(screen.getByRole('radio', { name: 'TCP (direct)' }));
    type('Listen host', '0.0.0.0');
    type('Port', '5000');
    type('Advertised host (required)', 'peer.example');
    fireEvent.click(screen.getByRole('button', { name: 'Save TCP' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls).toEqual([{ url: 'api/tcp', body: { host: '0.0.0.0', port: 5000, advertise: 'peer.example' } }]);
  });

  // Invariant: empty fields are left to the backend's defaults.
  it('an empty TCP form posts no fields', async () => {
    const calls = stubFetch();
    const refresh = vi.fn();
    render(<TransportPanel state={stateWith()} refresh={refresh} />);
    fireEvent.click(screen.getByRole('radio', { name: 'TCP (direct)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save TCP' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls).toEqual([{ url: 'api/tcp', body: {} }]);
  });

  // Invariant: the human is warned exactly when the listen host leaves loopback.
  it('a non-loopback host shows the exposure warning', () => {
    render(<TransportPanel state={stateWith({ kind: 'tcp', configured: true, host: '127.0.0.1', port: 47821, advertise: '127.0.0.1' })} refresh={() => {}} />);
    expect(screen.queryByRole('note', { name: 'Exposure warning' })).toBeNull();
    type('Listen host', '192.168.1.20');
    expect(screen.getByRole('note', { name: 'Exposure warning' })).toBeTruthy();
    type('Listen host', '127.0.0.2');
    expect(screen.queryByRole('note', { name: 'Exposure warning' })).toBeNull();
    // A hostname that only looks like loopback is exposed like any other.
    type('Listen host', '127.example.com');
    expect(screen.getByRole('note', { name: 'Exposure warning' })).toBeTruthy();
    type('Listen host', '127.0.0.256');
    expect(screen.getByRole('note', { name: 'Exposure warning' })).toBeTruthy();
  });

  // Invariant: loopback means an actual loopback literal or localhost; wildcard means an all-zero literal.
  it('classifies hosts by address, not by prefix', () => {
    for (const h of ['', 'localhost', '127.0.0.1', '127.255.0.9', '::1']) expect(isLoopback(h), h).toBe(true);
    for (const h of ['127.example.com', '127.0.0.256', '1270.0.0.1', '10.0.0.1', '0.0.0.0', '::']) expect(isLoopback(h), h).toBe(false);
    for (const h of ['0.0.0.0', '::', '::0', '0:0:0:0:0:0:0:0', '0000::', '::ffff:0.0.0.0', '::ffff:0:0', '0:0:0:0:0:ffff:0.0.0.0', '::0.0.0.0']) expect(isWildcard(h), h).toBe(true);
    for (const h of ['::1', '0.0.0.1', 'example.com', '127.0.0.1', '::ffff:1.2.3.4', '::ffff:0.0.0.1', '1::', ':::', '::ffff:0.0.0.256', '0:0:0:0:0:0:0:0:0']) expect(isWildcard(h), h).toBe(false);
  });

  // Invariant: the advertised host is labelled required for every wildcard the backend refuses without one.
  it('labels the advertised host required for an IPv4-mapped wildcard', () => {
    render(<TransportPanel state={stateWith({ kind: 'tcp', configured: true, host: '127.0.0.1', port: 47821, advertise: '127.0.0.1' })} refresh={() => {}} />);
    type('Listen host', '::ffff:0.0.0.0');
    expect(screen.getByRole('textbox', { name: 'Advertised host (required)' })).toBeTruthy();
    type('Listen host', '192.168.1.20');
    expect(screen.getByRole('textbox', { name: 'Advertised host' })).toBeTruthy();
  });

  // Invariant: the human can see that writes are waiting, and the code of the last failure that holds them.
  it('shows the writes waiting and why the last attempt failed', () => {
    const { rerender } = render(<TransportPanel state={stateWith({ kind: 'file-share', configured: true, dir: '/srv/share' })} refresh={() => {}} />);
    expect(screen.queryByRole('status', { name: 'Writes waiting' })).toBeNull();
    rerender(<TransportPanel state={stateWith({ kind: 'file-share', configured: true, dir: '/srv/share', outboxError: { code: 'SHARE_UNSAFE', message: 'not a real directory' } }, 2)} refresh={() => {}} />);
    const waiting = screen.getByRole('status', { name: 'Writes waiting' });
    expect(waiting.textContent).toContain('2');
    expect(waiting.textContent).toContain('SHARE_UNSAFE');
  });

  // Invariant: a transport that failed to start says why, by code.
  it('shows the transport error code', () => {
    render(<TransportPanel state={stateWith({ kind: 'tcp', host: '127.0.0.1', port: 1, advertise: '127.0.0.1', error: { code: 'TCP_LISTEN_FAILED', message: 'cannot listen' } })} refresh={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('TCP_LISTEN_FAILED');
  });

  // Invariant: the hub form posts exactly the address the human entered to the relative api/hub.
  it('choosing Hub posts api/hub with the entered address', async () => {
    const calls = stubFetch();
    const refresh = vi.fn();
    render(<TransportPanel state={stateWith()} refresh={refresh} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Hub' }));
    type('Hub address', ' hub://hub.example:47822 ');
    fireEvent.click(screen.getByRole('button', { name: 'Save hub' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls).toEqual([{ url: 'api/hub', body: { url: 'hub://hub.example:47822' } }]);
  });

  // Invariant: the human sees whether the hub link is up, and the code of what keeps it down.
  it('shows the hub connection state and its error', () => {
    const hub = { kind: 'hub' as const, configured: true, url: 'hub://hub.example:47822' };
    const { rerender } = render(<TransportPanel state={stateWith({ ...hub, hub: { connected: true, error: null } })} refresh={() => {}} />);
    expect(screen.getByRole('status', { name: 'Hub connection' }).textContent).not.toContain('not');
    rerender(<TransportPanel state={stateWith({ ...hub, hub: { connected: false, error: { code: 'HUB_DUPLICATE', message: 'another endpoint registered this identity' } } })} refresh={() => {}} />);
    const status = screen.getByRole('status', { name: 'Hub connection' });
    expect(status.textContent).toContain('not connected');
    expect(status.textContent).toContain('HUB_DUPLICATE');
  });

  // Invariant: choosing the hub tells the human what the hub can see.
  it('shows the hub plaintext note', () => {
    render(<TransportPanel state={stateWith()} refresh={() => {}} />);
    expect(screen.queryByRole('note', { name: 'Hub plaintext note' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Hub' }));
    expect(screen.getByRole('note', { name: 'Hub plaintext note' })).toBeTruthy();
  });
});
