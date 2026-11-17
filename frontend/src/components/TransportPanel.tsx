import { useState } from 'react';
import { api } from '../api';
import type { State } from '../types';
import { useAction } from '../useAction';
import { Panel } from './Panel';

type Kind = 'file-share' | 'tcp';

// Reachable from this machine only: no warning. Anything else opens the port to the network.
const isLoopback = (h: string) => h === '' || h === 'localhost' || h === '::1' || /^127\./.test(h);
const isWildcard = (h: string) => h === '0.0.0.0' || h === '::';

const DESCRIBE: Record<Kind, string> = { 'file-share': 'file share', tcp: 'TCP (direct)' };

// Picks the one transport this install uses: the file share (a directory every install reaches) or direct TCP.
// Empty TCP fields are left to the backend's defaults (loopback, the default port).
export function TransportPanel({ state, refresh }: { state: State; refresh: () => void }) {
  const t = state.transport;
  const [kind, setKind] = useState<Kind>(t.kind ?? 'file-share');
  const [dir, setDir] = useState(t.dir ?? '');
  const [host, setHost] = useState(t.host ?? '');
  const [port, setPort] = useState(t.port === null ? '' : String(t.port));
  const [advertise, setAdvertise] = useState(t.advertise !== null && t.advertise !== t.host ? t.advertise : '');
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
      </dl>
      {t.error && <p role="alert" className="error">{t.error.code}: {t.error.message}</p>}
      <fieldset>
        <legend>Transport</legend>
        <label><input type="radio" name="transport" checked={kind === 'file-share'} onChange={() => setKind('file-share')} /> File share</label>
        <label><input type="radio" name="transport" checked={kind === 'tcp'} onChange={() => setKind('tcp')} /> TCP (direct)</label>
      </fieldset>
      {kind === 'file-share' ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api.setShare(dir)); }}>
          <label className="grow stack"><span>Share directory (absolute)</span><input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="the Dropbox, SMB or NFS folder every install can reach" /></label>
          <button type="submit" disabled={busy}>Save share</button>
        </form>
      ) : (
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
      <p className="muted">One transport at a time: peers on the other one cannot reach this install after a switch.</p>
      {error && <p role="alert" className="error">{error}</p>}
    </Panel>
  );
}
