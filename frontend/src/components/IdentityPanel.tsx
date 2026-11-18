import { useState } from 'react';
import { api } from '../api';
import type { State } from '../types';
import { useAction } from '../useAction';
import { Panel } from './Panel';

const NAME_STATUS: Record<string, string> = {
  shown: 'announced',
  unannounced: 'not announced yet',
  NAME_TAKEN: 'hidden: this name is pinned to another identity here',
  NAME_CONFLICT: 'hidden: another identity claims the same name',
};

export function IdentityPanel({ state, refresh }: { state: State; refresh: () => void }) {
  const [name, setName] = useState(state.identity.name ?? '');
  const { busy, error, run } = useAction(refresh);
  const { identity, transport } = state;
  return (
    <Panel title="Identity">
      <dl className="facts">
        <dt>Fingerprint</dt><dd className="mono">{identity.fingerprint}</dd>
        <dt>Announced as</dt><dd>{identity.announcedName ?? '—'} ({NAME_STATUS[identity.nameStatus] ?? identity.nameStatus})</dd>
      </dl>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api.setName(name)); }}>
        <label className="grow stack"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. my-machine" /></label>
        <button type="submit" disabled={busy}>Save name</button>
      </form>
      <div className="row">
        <button type="button" data-variant="primary" disabled={busy || !transport.configured || !identity.name} onClick={() => void run(() => api.announce())}>Announce</button>
      </div>
      <p className="muted">Your announcement is presented on every connection and hub, and again at every start.</p>
      {error && <p role="alert" className="error">{error}</p>}
    </Panel>
  );
}
