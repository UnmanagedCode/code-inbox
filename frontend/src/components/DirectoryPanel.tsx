import { useState } from 'react';
import { api } from '../api';
import type { Presence, State } from '../types';
import { who } from '../format';
import { useAction } from '../useAction';
import { ConfirmButton } from './ConfirmButton';
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
  // An identity's control follows the personal inbox with it: Revoke once accepted, Invite pending while an invite
  // is open either way, else Invite.
  const personalWith = (fp: string) => state.inboxes.find((b) => b.kind === 'personal' && b.members.some((m) => m.fp === fp));
  const inviteOpenWith = (fp: string) => state.invites.incoming.some((i) => i.kind === 'personal' && i.from.fp === fp)
    || state.invites.outgoing.some((i) => i.kind === 'personal' && i.to.fp === fp);
  function identityControl(fp: string) {
    const inbox = personalWith(fp);
    if (inbox) return <ConfirmButton label="Revoke" confirmLabel="Confirm revoke" disabled={busy} onConfirm={() => void run(() => api.deleteInbox(inbox.id))} />;
    if (inviteOpenWith(fp)) return <button type="button" disabled>Invite pending</button>;
    return <button type="button" disabled={busy} onClick={() => void run(() => api.invite(fp))}>Invite to personal inbox</button>;
  }
  function sharedControl(s: State['sharedInboxes'][number]) {
    if (s.isOwner) return <ConfirmButton label="Delete" confirmLabel="Confirm delete" disabled={busy} onConfirm={() => void run(() => api.deleteInbox(s.id))} />;
    if (s.isMember) return <ConfirmButton label="Leave" confirmLabel="Confirm leave" disabled={busy} onConfirm={() => void run(() => api.leaveInbox(s.id))} />;
    if (s.requestPending) return <button type="button" disabled>Request pending</button>;
    return <button type="button" disabled={busy} onClick={() => void run(() => api.requestJoin(s.id))}>Request to join</button>;
  }
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
              {identityControl(d.fp)}
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
              {sharedControl(s)}
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
