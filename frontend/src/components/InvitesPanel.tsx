import { api } from '../api';
import type { State } from '../types';
import { who } from '../format';
import { useAction } from '../useAction';
import { Panel } from './Panel';

export function InvitesPanel({ state, refresh }: { state: State; refresh: () => void }) {
  const { busy, error, run } = useAction(refresh);
  const { invites, joinRequests } = state;
  const nothing = !invites.incoming.length && !invites.outgoing.length && !joinRequests.incoming.length && !joinRequests.outgoing.length;
  return (
    <Panel title="Invites and requests">
      {nothing && <p className="muted">Nothing waiting.</p>}
      <ul className="list">
        {invites.incoming.map((i) => (
          <li key={i.id} className="row">
            <span className="grow">{who(i.from)} invites you to {i.kind === 'shared' ? <>the shared inbox <strong>{i.inboxName ?? i.inbox.slice(0, 8)}</strong></> : 'a personal inbox'}</span>
            <button type="button" data-variant="primary" disabled={busy} onClick={() => void run(() => api.respondInvite(i.id, true))}>Accept</button>
            <button type="button" disabled={busy} onClick={() => void run(() => api.respondInvite(i.id, false))}>Decline</button>
          </li>
        ))}
        {joinRequests.incoming.map((r) => (
          <li key={r.id} className="row">
            <span className="grow">{who(r.from)} asks to join <strong>{r.inboxName ?? r.inbox.slice(0, 8)}</strong></span>
            <button type="button" data-variant="primary" disabled={busy} onClick={() => void run(() => api.respondJoin(r.id, true))}>Accept</button>
            <button type="button" disabled={busy} onClick={() => void run(() => api.respondJoin(r.id, false))}>Decline</button>
          </li>
        ))}
        {invites.outgoing.map((i) => (
          <li key={i.id} className="muted">Waiting for {who(i.to)} to answer your {i.kind === 'shared' ? `invite to ${i.inboxName ?? i.inbox.slice(0, 8)}` : 'personal invite'}</li>
        ))}
        {joinRequests.outgoing.map((r) => (
          <li key={r.id} className="muted">Waiting for the owner of {r.inboxName ?? r.inbox.slice(0, 8)} to answer your join request</li>
        ))}
      </ul>
      {error && <p role="alert" className="error">{error}</p>}
    </Panel>
  );
}
