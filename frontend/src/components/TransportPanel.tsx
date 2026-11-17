import { useState } from 'react';
import { api } from '../api';
import type { State } from '../types';
import { useAction } from '../useAction';
import { Panel } from './Panel';

type Kind = 'file-share' | 'tcp' | 'hub';

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// Reachable from this machine only, so no warning: empty (the backend's 127.0.0.1), `localhost`, an IPv4 literal
// in 127.0.0.0/8, or `::1`. A hostname that merely starts with 127 is not: it resolves wherever its DNS says.
export const isLoopback = (h: string) => h === '' || h === 'localhost' || h === '::1' || (IPV4_RE.test(h) && h.startsWith('127.'));

// The eight 16-bit groups of an IPv6 literal (an IPv4 tail counts as two), or null when `h` is not one.
function ipv6Groups(h: string): number[] | null {
  if (!h.includes(':')) return null;
  let text = h;
  let tail: number[] = [];
  const v4 = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(h);
  if (v4) {
    if (!IPV4_RE.test(v4[2])) return null;
    const [a, b, c, d] = v4[2].split('.').map(Number);
    tail = [(a << 8) | b, (c << 8) | d];
    text = v4[1].endsWith('::') ? v4[1] : v4[1].slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (![...head, ...rest].every((x) => /^[0-9a-fA-F]{1,4}$/.test(x))) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const hex = (xs: string[]) => xs.map((x) => parseInt(x, 16));
  return [...hex(head), ...Array<number>(8 - known).fill(0), ...hex(rest), ...tail];
}

// "Every interface", decided like the backend's isWildcardHost: 0.0.0.0, or an IPv6 literal for `::` in any
// spelling, or its IPv4-mapped form (`::ffff:0.0.0.0`). A name that resolves to one is caught by the backend only
// (it needs a DNS lookup); this labels the advertised host as required.
export function isWildcard(h: string) {
  if (h === '0.0.0.0') return true;
  const g = ipv6Groups(h);
  if (!g) return false;
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  return zeroUpTo(8) || (zeroUpTo(5) && g[5] === 0xffff && g[6] === 0 && g[7] === 0);
}

const DESCRIBE: Record<Kind, string> = { 'file-share': 'file share', tcp: 'TCP (direct)', hub: 'hub' };

// Picks the one transport this install uses: the file share (a directory every install reaches), direct TCP or a
// hub. Empty TCP fields are left to the backend's defaults (loopback, the default port).
export function TransportPanel({ state, refresh }: { state: State; refresh: () => void }) {
  const t = state.transport;
  const [kind, setKind] = useState<Kind>(t.kind ?? 'file-share');
  const [dir, setDir] = useState(t.dir ?? '');
  const [host, setHost] = useState(t.host ?? '');
  const [port, setPort] = useState(t.port === null ? '' : String(t.port));
  const [advertise, setAdvertise] = useState(t.advertise !== null && t.advertise !== t.host ? t.advertise : '');
  const [url, setUrl] = useState(t.url ?? '');
  const { busy, error, run } = useAction(refresh);
  const h = host.trim();
  const exposed = !isLoopback(h);
  const saveTcp = () => {
    const p = port.trim();
    return api.setTcp({
      ...(h ? { host: h } : {}),
      ...(p ? { port: /^\d+$/.test(p) ? Number(p) : p } : {}),
      ...(advertise.trim() ? { advertise: advertise.trim() } : {}),
    });
  };
  return (
    <Panel title="Transport">
      <dl className="facts">
        <dt>In use</dt><dd>{t.configured && t.kind ? DESCRIBE[t.kind] : 'none'}</dd>
        {t.kind === 'file-share' && t.dir && <><dt>Share</dt><dd className="mono">{t.dir}</dd></>}
        {t.kind === 'tcp' && <><dt>Reachable at</dt><dd className="mono">{t.addresses.length ? t.addresses.join(', ') : '—'}</dd></>}
        {t.kind === 'hub' && t.url && <><dt>Hub</dt><dd className="mono">{t.url}</dd></>}
        {t.kind === 'hub' && t.hub && (
          <><dt>Connection</dt><dd role="status" aria-label="Hub connection">{t.hub.connected ? 'connected' : 'not connected'}{t.hub.error && ` (${t.hub.error.code}: ${t.hub.error.message})`}</dd></>
        )}
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
        <label><input type="radio" name="transport" checked={kind === 'file-share'} onChange={() => setKind('file-share')} /> File share</label>
        <label><input type="radio" name="transport" checked={kind === 'tcp'} onChange={() => setKind('tcp')} /> TCP (direct)</label>
        <label><input type="radio" name="transport" checked={kind === 'hub'} onChange={() => setKind('hub')} /> Hub</label>
      </fieldset>
      {kind === 'file-share' && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api.setShare(dir)); }}>
          <label className="grow stack"><span>Share directory (absolute)</span><input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="the Dropbox, SMB or NFS folder every install can reach" /></label>
          <button type="submit" disabled={busy}>Save share</button>
          <p className="muted">Save with the share mounted: saving creates its code-inbox folder, and writes wait until that folder is there.</p>
        </form>
      )}
      {kind === 'tcp' && (
        <form onSubmit={(e) => { e.preventDefault(); void run(saveTcp); }}>
          <div className="row">
            <label className="grow stack"><span>Listen host</span><input value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" /></label>
            <label className="stack"><span>Port</span><input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder="default" /></label>
          </div>
          {(exposed || advertise) && (
            <div className="row">
              <label className="grow stack"><span>Advertised host{isWildcard(h) ? ' (required)' : ''}</span><input value={advertise} onChange={(e) => setAdvertise(e.target.value)} placeholder="the host or IP peers dial" /></label>
            </div>
          )}
          {exposed && <p role="note" aria-label="Exposure warning" className="warning">Listening on {h} exposes an open port to the network; records travel unencrypted.</p>}
          <div className="row"><button type="submit" disabled={busy}>Save TCP</button></div>
        </form>
      )}
      {kind === 'hub' && (
        <form onSubmit={(e) => { e.preventDefault(); void run(() => api.setHub(url.trim())); }}>
          <div className="row">
            <label className="grow stack"><span>Hub address</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="hub://host:port" /></label>
            <button type="submit" disabled={busy}>Save hub</button>
          </div>
          <p role="note" aria-label="Hub plaintext note" className="muted">The hub routes by fingerprint and cannot forge senders, but it sees who talks to whom and reads every record. Peers must use the same hub.</p>
        </form>
      )}
      <p className="muted">One transport at a time: peers on another one cannot reach this install after a switch.</p>
      {error && <p role="alert" className="error">{error}</p>}
    </Panel>
  );
}
