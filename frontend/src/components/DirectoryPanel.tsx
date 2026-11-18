import { useState } from 'react';
import { api } from '../api';
import type { Presence, State } from '../types';
import { who } from '../format';
import { useAction } from '../useAction';
import { Panel } from './Panel';

// Where an identity is now, in words: each hub that has it and each session to it.
export function describePresence(presence: Presence[]) {
  if (presence.length === 0) return 'not connected';
  return presence.map((p) => (p.via === 'hub' ? `on hub ${p.address}` : p.address ? `connected via ${p.address}` : 'connected to your listener')).join(', ');
}

// Every identity this install knows of, strangers included (seen on a hub or met on a connection): any of them can be
// invited, which makes it a contact.
export function DirectoryPanel({ state, refresh }: { state: State; refresh: () => void }) {
  const [inboxName, setInboxName] = useState('');
  const { busy, error, run } = useAction(refresh);
  return (
    <Panel title="Directory">
      <h3>Identities</h3>
      {state.directory.length === 0 ? <p className="muted">No other identity is known yet.</p> : (
        <ul className="list">
          {state.directory.map((d) => (
            <li key={d.fp} className="row">
              <span className="grow">
                <strong>{d.name}</strong> <span className="mono muted">{d.fingerprint}</span>
                {!d.contact && <> <span className="tag">not a contact</span></>}
                {' '}<span role="status" aria-label={`Presence of ${d.name}`} className="muted">{describePresence(d.presence)}</span>
              </span>
              <button type="button" disabled={busy} onClick={() => void run(() => api.invite(d.fp))}>Invite to personal inbox</button>
            </li>
          ))}
        </ul>
      )}
      <h3>Shared inboxes</h3>
      {state.sharedInboxes.length === 0 ? <p className="muted">No shared inbox yet.</p> : (
        <ul className="list">
          {state.sharedInboxes.map((s) => (
            <li key={s.id} className="row">
              <span className="grow"><strong>{s.name}</strong> <span className="muted">owner {who(s.owner)}{s.memberCount !== null ? `, ${s.memberCount} member(s)` : ''}</span></span>
              {s.isMember ? <span className="muted">member</span>
                : s.requestPending ? <span className="muted">request sent</span>
                  : <button type="button" disabled={busy} onClick={() => void run(() => api.requestJoin(s.id))}>Request to join</button>}
            </li>
          ))}
        </ul>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.createInbox(inboxName); setInboxName(''); }); }}>
        <label className="grow stack"><span>New shared inbox</span><input value={inboxName} onChange={(e) => setInboxName(e.target.value)} placeholder="name" /></label>
        <button type="submit" disabled={busy || !inboxName}>Create</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
    </Panel>
  );
}
