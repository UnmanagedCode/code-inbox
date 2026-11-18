import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TransportPanel, isLoopback } from './TransportPanel';
import type { ConnectionView, State, TransportView } from '../types';

const NONE: TransportView = { kind: null, configured: false, dir: null, listen: null, listening: null, connections: [], card: null, error: null, outboxError: null };
const stateWith = (transport: Partial<TransportView> = {}, outbox = 0) => ({ transport: { ...NONE, ...transport }, diagnostics: { outbox } }) as unknown as State;
const row = (address: string, c: Partial<ConnectionView> = {}): ConnectionView => ({ address, kind: null, state: 'connecting', peers: [], error: null, ...c });
const network = (t: Partial<TransportView> = {}) => stateWith({ kind: 'network', configured: true, listen: { host: '127.0.0.1', port: 47821 }, ...t });

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
  // Invariant: the network form posts the whole config to the relative api/network: the listener as entered (empty
  // fields left to the backend's defaults) and the saved connections.
  it('Save listener posts api/network with the entered listener and the saved connections', async () => {
    const calls = stubFetch();
    const refresh = vi.fn();
    const { unmount } = render(<TransportPanel state={stateWith()} refresh={refresh} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Network' }));
    type('Listen host', '0.0.0.0');
    type('Port', '5000');
    fireEvent.click(screen.getByRole('button', { name: 'Save listener' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    unmount();
    render(<TransportPanel state={network({ listen: null, connections: [row('hub.example:47822')] })} refresh={refresh} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Accept direct connections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save listener' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(calls).toEqual([
      { url: 'api/network', body: { listen: { host: '0.0.0.0', port: 5000 }, connections: [] } },
      { url: 'api/network', body: { listen: {}, connections: ['hub.example:47822'] } },
    ]);
  });

  // Invariant: Add and Remove post the saved listener with the edited connection list.
  it('Add and Remove post the saved listener with the edited list', async () => {
    const calls = stubFetch();
    const refresh = vi.fn();
    render(<TransportPanel state={network({ connections: [row('a.example:1'), row('b.example:2')] })} refresh={refresh} />);
    type('Connect to', ' c.example:3 ');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    const listen = { host: '127.0.0.1', port: 47821 };
    expect(calls).toEqual([
      { url: 'api/network', body: { listen, connections: ['a.example:1', 'b.example:2', 'c.example:3'] } },
      { url: 'api/network', body: { listen, connections: ['b.example:2'] } },
    ]);
  });

  // Invariant: each connection row says what answered there, its state, who it reached and why it is down.
  it('connection rows expose kind, state, peers and error by accessible name', () => {
    render(<TransportPanel state={network({
      connections: [
        row('peer.example:1', { kind: 'peer', state: 'up', peers: [{ fp: 'a'.repeat(64), name: 'bob' }] }),
        row('hub.example:2', { kind: 'hub', state: 'stopped', error: { code: 'HUB_DUPLICATE', message: 'replaced' } }),
        row('dead.example:3', { state: 'waiting', error: { code: 'ECONNREFUSED', message: 'refused' } }),
      ],
    })} refresh={() => {}} />);
    const peer = screen.getByRole('status', { name: 'Connection peer.example:1' }).textContent ?? '';
    expect(peer).toContain('peer');
    expect(peer).toContain('connected');
    expect(peer).toContain('bob');
    const hub = screen.getByRole('status', { name: 'Connection hub.example:2' }).textContent ?? '';
    expect(hub).toContain('hub');
    expect(hub).toContain('HUB_DUPLICATE');
    const dead = screen.getByRole('status', { name: 'Connection dead.example:3' }).textContent ?? '';
    expect(dead).toContain('detecting');
    expect(dead).toContain('ECONNREFUSED');
  });

  // Invariant: the human is warned exactly when the listen host leaves loopback.
  it('a non-loopback listen host shows the exposure warning', () => {
    render(<TransportPanel state={network()} refresh={() => {}} />);
    expect(screen.queryByRole('note', { name: 'Exposure warning' })).toBeNull();
    type('Listen host', '192.168.1.20');
    expect(screen.getByRole('note', { name: 'Exposure warning' })).toBeTruthy();
    type('Listen host', '127.0.0.2');
    expect(screen.queryByRole('note', { name: 'Exposure warning' })).toBeNull();
    // A hostname that only looks like loopback is exposed like any other.
    type('Listen host', '127.example.com');
    expect(screen.getByRole('note', { name: 'Exposure warning' })).toBeTruthy();
    // No listener, no open port.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Accept direct connections' }));
    expect(screen.queryByRole('note', { name: 'Exposure warning' })).toBeNull();
  });

  // Invariant: loopback means an actual loopback literal or localhost.
  it('classifies hosts by address, not by prefix', () => {
    for (const h of ['', 'localhost', '127.0.0.1', '127.255.0.9', '::1']) expect(isLoopback(h), h).toBe(true);
    for (const h of ['127.example.com', '127.0.0.256', '1270.0.0.1', '10.0.0.1', '0.0.0.0', '::']) expect(isLoopback(h), h).toBe(false);
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
    render(<TransportPanel state={network({ configured: false, error: { code: 'LISTEN_FAILED', message: 'cannot listen' } })} refresh={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('LISTEN_FAILED');
  });

  // Invariant: choosing network mode tells the human what a connection and a hub can see.
  it('shows the network notes', () => {
    render(<TransportPanel state={stateWith()} refresh={() => {}} />);
    expect(screen.queryByRole('note', { name: 'Network notes' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Network' }));
    expect(screen.getByRole('note', { name: 'Network notes' })).toBeTruthy();
  });
});
