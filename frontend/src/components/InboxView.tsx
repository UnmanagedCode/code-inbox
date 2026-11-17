import { useCallback, useState } from 'react';
import { api, describe } from '../api';
import type { Inbox, Message, State } from '../types';
import { who } from '../format';
import { useAction } from '../useAction';
import { usePoll } from '../usePoll';
import { ComposeBox } from './ComposeBox';
import { inboxLabel } from './InboxList';
import { MessageList } from './MessageList';

export const POLL_MS = 3000;

function OwnerControls({ inbox, state, refresh }: { inbox: Inbox; state: State; refresh: () => void }) {
  const { busy, error, run } = useAction(refresh);
  const [to, setTo] = useState('');
  const memberFps = new Set(inbox.members.map((m) => m.fp));
  const candidates = state.directory.filter((d) => !memberFps.has(d.fp));
  return (
    <div className="owner">
      <ul className="list">
        {inbox.members.filter((m) => m.fp !== state.identity.fp).map((m) => (
          <li key={m.fp} className="row">
            <span className="grow">{who(m)}</span>
            <button type="button" data-variant="destructive" disabled={busy} onClick={() => void run(() => api.removeMember(inbox.id, m.fp))}>Remove</button>
          </li>
        ))}
      </ul>
      {candidates.length > 0 && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (to) void run(() => api.inviteMember(inbox.id, to)); }}>
          <label className="grow stack">
            <span>Invite a member</span>
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">choose an identity</option>
              {candidates.map((d) => <option key={d.fp} value={d.fp}>{d.name} [{d.fp.slice(0, 16)}]</option>)}
            </select>
          </label>
          <button type="submit" disabled={busy || !to}>Invite</button>
        </form>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}

// One inbox: its members, its messages (reloaded while visible) and a compose box.
export function InboxView({ inbox, state, refresh, back }: { inbox: Inbox; state: State; refresh: () => void; back: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.messages(inbox.id).then((r) => { setMessages(r.messages); setError(null); }, (e) => setError(describe(e)));
  }, [inbox.id]);
  usePoll(load, POLL_MS, [inbox.id]);
  const isOwner = inbox.kind === 'shared' && inbox.owner?.fp === state.identity.fp;
  return (
    <section className="panel inbox" aria-label={`Inbox ${inboxLabel(inbox, state.identity.fp)}`}>
      <div className="row">
        <button type="button" data-variant="ghost" onClick={back}>← Inboxes</button>
        <h2 className="grow">{inboxLabel(inbox, state.identity.fp)} <span className="muted">({inbox.kind})</span></h2>
      </div>
      <p className="muted">Members: {inbox.members.map(who).join(', ')}</p>
      {isOwner && <OwnerControls inbox={inbox} state={state} refresh={refresh} />}
      {error && <p role="alert" className="error">{error}</p>}
      <MessageList messages={messages} />
      <ComposeBox inboxId={inbox.id} onSent={() => { load(); refresh(); }} />
    </section>
  );
}
