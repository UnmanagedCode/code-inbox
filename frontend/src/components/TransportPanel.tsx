import { useState } from 'react';
import { api } from '../api';
import { short } from '../format';
import type { ConnectionView, State } from '../types';
import { useAction } from '../useAction';
import { Panel } from './Panel';

type Kind = 'file-share' | 'network';

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// Reachable from this machine only, so no warning: empty (the backend's 127.0.0.1), `localhost`, an IPv4 literal
// in 127.0.0.0/8, or `::1`. A hostname that merely starts with 127 is not: it resolves wherever its DNS says.
export const isLoopback = (h: string) => h === '' || h === 'localhost' || h === '::1' || (IPV4_RE.test(h) && h.startsWith('127.'));

const DESCRIBE: Record<Kind, string> = { 'file-share': 'file share', network: 'network' };
const KIND: Record<string, string> = { peer: 'peer', hub: 'hub' };
const STATE: Record<ConnectionView['state'], string> = {
  connecting: 'connecting',
  up: 'connected',
  waiting: 'waiting to retry',
  idle: 'idle (another direct session serves it)',
  stopped: 'stopped',
};

// One connection's row: its address, what answered there, its state, who it reached and why it is down.
function ConnectionRow({ c, busy, onRemove }: { c: ConnectionView; busy: boolean; onRemove: () => void }) {
  const peers = c.peers.map((p) => p.name ?? short(p.fp)).join(', ');
  const summary = [
    KIND[c.kind ?? ''] ?? 'detecting',
    STATE[c.state],
    ...(peers ? [peers] : []),
    ...(c.error ? [`${c.error.code}: ${c.error.message}`] : []),
  ].join(' · ');
  return (
    <li className="row">
      <span className="grow"><span className="mono">{c.address}</span> <span role="status" aria-label={`Connection ${c.address}`} className="muted">{summary}</span></span>
      <button type="button" disabled={busy} onClick={onRemove}>Remove</button>
    </li>
  );
}

// Picks how this install reaches others: the file share (a directory every install reaches), or network mode: an
// optional listener plus connections to peers' listeners or hubs. Empty listener fields are left to the backend's
// defaults (loopback, the default port).
export function TransportPanel({ state, refresh }: { state: State; refresh: () => void }) {
  const t = state.transport;
  const [kind, setKind] = useState<Kind>(t.kind ?? 'file-share');
  const [dir, setDir] = useState(t.dir ?? '');
  const [listenOn, setListenOn] = useState(t.kind !== 'network' || t.listen !== null);
  const [host, setHost] = useState(t.listen?.host ?? '');
  const [port, setPort] = useState(t.listen ? String(t.listen.port) : '');
  const [address, setAddress] = useState('');
  const { busy, error, run } = useAction(refresh);
  const h = host.trim();
  const exposed = listenOn && !isLoopback(h);
  const saved = t.kind === 'network' ? t.connections.map((c) => c.address) : [];
  // The listener as edited: null when off, else only the fields the human filled in.
  const listen = () => {
    if (!listenOn) return null;
    const p = port.trim();
    return { ...(h ? { host: h } : {}), ...(p ? { port: /^\d+$/.test(p) ? Number(p) : p } : {}) };
  };
  // The saved listener, unchanged, for edits of the connection list.
  const savedListen = () => (t.kind === 'network' ? t.listen : listen());
  return (
    <Panel title="Transport">
      <dl className="facts">
        <dt>In use</dt><dd>{t.configured && t.kind ? DESCRIBE[t.kind] : 'none'}</dd>
        {t.kind === 'file-share' && t.dir && <><dt>Share</dt><dd className="mono">{t.dir}</dd></>}
        {t.kind === 'network' && <><dt>Listening on</dt><dd className="mono">{t.listening ? `${t.listening.host}:${t.listening.port}` : '—'}</dd></>}
      </dl>
      {t.error && <p role="alert" className="error">{t.error.code}: {t.error.message}</p>}
      {state.diagnostics.outbox > 0 && (
        <div role="status" aria-label="Writes waiting">
          <p className="muted">{state.diagnostics.outbox} write(s) waiting in the outbox, retried until delivered.</p>
          {t.outboxError && <p className="warning">Last attempt: {t.outboxError.code}: {t.outboxError.message}</p>}
          {t.outboxError?.code === 'SHARE_UNAVAILABLE' && <p className="muted">The share looks unmounted. If it is mounted and new, save the share once more (with it mounted).</p>}
        </div>
      )}
      <fieldset>
        <legend>Transport</legend>
        <label className="check"><input type="radio" name="transport" checked={kind === 'file-share'} onChange={() => setKind('file-share')} /> File share</label>
        <label className="check"><input type="radio" name="transport" checked={kind === 'network'} onChange={() => setKind('network')} /> Network</label>
      </fieldset>
      {kind === 'file-share' && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api.setShare(dir)); }}>
          <label className="grow stack"><span>Share directory (absolute)</span><input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="the Dropbox, SMB or NFS folder every install can reach" /></label>
          <button type="submit" disabled={busy}>Save share</button>
          <p className="muted">Save with the share mounted: saving creates its code-inbox folder, and writes wait until that folder is there.</p>
        </form>
      )}
      {kind === 'network' && (
        <>
          <h3>Listener</h3>
          <form onSubmit={(e) => { e.preventDefault(); void run(() => api.setNetwork({ listen: listen(), connections: saved })); }}>
            <label className="check"><input type="checkbox" checked={listenOn} onChange={(e) => setListenOn(e.target.checked)} /> Accept direct connections</label>
            {listenOn && (
              <div className="row">
                <label className="grow stack"><span>Listen host</span><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" /></label>
                <label className="stack"><span>Port</span><input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder="default" /></label>
              </div>
            )}
            {exposed && <p role="note" aria-label="Exposure warning" className="warning">Listening on {h} exposes an open port to the network; records travel unencrypted.</p>}
            <div className="row"><button type="submit" disabled={busy}>Save listener</button></div>
          </form>
          <h3>Connections</h3>
          {t.kind === 'network' && t.connections.length > 0 ? (
            <ul className="list" aria-label="Connections">
              {t.connections.map((c) => (
                <ConnectionRow key={c.address} c={c} busy={busy} onRemove={() => void run(() => api.setNetwork({ listen: savedListen(), connections: saved.filter((a) => a !== c.address) }))} />
              ))}
            </ul>
          ) : <p className="muted">No connection yet.</p>}
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.setNetwork({ listen: savedListen(), connections: [...saved, address.trim()] }); setAddress(''); }); }}>
            <label className="grow stack"><span>Connect to</span><input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="host:port of a peer's listener or a hub" /></label>
            <button type="submit" disabled={busy || !address.trim()}>Add</button>
          </form>
          <ul role="note" aria-label="Network notes" className="muted">
            <li>A connection carries no identity: whoever proves a key at that address, a peer or a hub, becomes reachable.</li>
            <li>A hub reads every record it relays and sees who talks to whom; everyone on a hub sees every other client&apos;s name and when it is online.</li>
            <li>Contacts are dialed directly when a connection reaches them, else through the first hub that has them.</li>
          </ul>
        </>
      )}
      <p className="muted">One transport at a time: peers on another one cannot reach this install after a switch.</p>
      {error && <p role="alert" className="error">{error}</p>}
    </Panel>
  );
}
