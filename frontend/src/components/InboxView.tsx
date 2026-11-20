import { useCallback, useId, useState } from 'react';
import { api, describe } from '../api';
import type { Inbox, Message, State } from '../types';
import { who } from '../format';
import { useAction } from '../useAction';
import { usePoll } from '../usePoll';
import { useStickToBottom } from '../useStickToBottom';
import { ComposeBox } from './ComposeBox';
import { ConfirmButton } from './ConfirmButton';
import { inboxLabel } from './InboxList';
import { MessageList } from './MessageList';

export const POLL_MS = 3000;

// The owner's one control over a party (an identity in the directory or a member): Revoke a member (its removal),
// a disabled Invite pending while a shared invite to it is open, else Invite.
function OwnerControls({ inbox, state, refresh }: { inbox: Inbox; state: State; refresh: () => void }) {
  const { busy, error, run } = useAction(refresh);
  const [to, setTo] = useState('');
  const self = state.identity.fp;
  const memberFps = new Set(inbox.members.map((m) => m.fp));
  const parties = new Map<string, string>();
  for (const d of state.directory) if (d.fp !== self) parties.set(d.fp, `${d.name} [${d.fp.slice(0, 16)}]`);
  for (const m of inbox.members) if (m.fp !== self && !parties.has(m.fp)) parties.set(m.fp, who(m));
  const invited = (fp: string) => state.invites.outgoing.some((i) => i.kind === 'shared' && i.inbox === inbox.id && i.to.fp === fp);
  let control = <button type="button" disabled={busy || !to} onClick={() => void run(() => api.inviteMember(inbox.id, to))}>Invite</button>;
  if (to && memberFps.has(to)) control = <ConfirmButton label="Revoke" confirmLabel="Confirm revoke" disabled={busy} onConfirm={() => void run(() => api.removeMember(inbox.id, to))} />;
  else if (to && invited(to)) control = <button type="button" disabled>Invite pending</button>;
  return (
    <div className="owner">
      {parties.size > 0 && (
        <div className="row">
          <label className="grow stack">
            <span>Members and identities</span>
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">choose an identity</option>
              {[...parties].map(([fp, label]) => <option key={fp} value={fp}>{label}{memberFps.has(fp) ? ' (member)' : ''}</option>)}
            </select>
          </label>
          {control}
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}

// The header's closing action: the owner deletes a shared inbox, a member leaves it, either party revokes a
// personal one. On success the view goes back to the list.
function CloseAction({ inbox, state, refresh, back }: { inbox: Inbox; state: State; refresh: () => void; back: () => void }) {
  const { busy, error, run } = useAction(() => { refresh(); back(); });
  const isOwner = inbox.kind === 'shared' && inbox.owner?.fp === state.identity.fp;
  const [label, confirmLabel, act] = inbox.kind === 'personal' ? ['Revoke', 'Confirm revoke', api.deleteInbox]
    : isOwner ? ['Delete inbox', 'Confirm delete', api.deleteInbox] : ['Leave inbox', 'Confirm leave', api.leaveInbox];
  return (
    <>
      <ConfirmButton label={label} confirmLabel={confirmLabel} disabled={busy} onConfirm={() => void run(() => act(inbox.id))} />
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );
}

// One inbox: a header (members behind a toggle), the message history (the only part that scrolls, reloaded while
// visible) and a compose box pinned below it.
export function InboxView({ inbox, state, refresh, back }: { inbox: Inbox; state: State; refresh: () => void; back: () => void }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const membersId = useId();
  const load = useCallback(() => {
    api.messages(inbox.id).then((r) => { setMessages(r.messages); setError(null); }, (e) => setError(describe(e)));
  }, [inbox.id]);
  usePoll(load, POLL_MS, [inbox.id]);
  const { ref, onScroll, away, fresh, toLatest, stickNext } = useStickToBottom(messages?.at(-1)?.id ?? null);
  const isOwner = inbox.kind === 'shared' && inbox.owner?.fp === state.identity.fp;
  return (
    <section className="panel inbox" aria-label={`Inbox ${inboxLabel(inbox, state.identity.fp)}`}>
      <header className="inbox-head">
        <div className="row">
          <button type="button" data-variant="ghost" onClick={back}>← Inboxes</button>
          <h2 className="grow">{inboxLabel(inbox, state.identity.fp)} <span className="muted">({inbox.kind})</span></h2>
          <CloseAction inbox={inbox} state={state} refresh={refresh} back={back} />
        </div>
        <button type="button" data-variant="ghost" aria-expanded={showMembers} aria-controls={membersId} onClick={() => setShowMembers((v) => !v)}>
          Members ({inbox.members.length})
        </button>
        {showMembers && (
          <div id={membersId}>
            <p className="muted">{inbox.members.map(who).join(', ')}</p>
            {isOwner && <OwnerControls inbox={inbox} state={state} refresh={refresh} />}
          </div>
        )}
        {error && <p role="alert" className="error">{error}</p>}
      </header>
      <div className="messages-wrap">
        <div ref={ref} className="messages-scroll" role="region" aria-label="Message history" tabIndex={0} data-away={away || undefined} onScroll={onScroll}>
          {messages === null ? <p className="muted">Loading messages…</p> : <MessageList messages={messages} selfFp={state.identity.fp} />}
        </div>
        {away && <button type="button" data-variant="primary" className="jump" onClick={toLatest}>{fresh ? 'New messages ↓' : 'Jump to latest ↓'}</button>}
      </div>
      <ComposeBox inboxId={inbox.id} onSent={() => { stickNext(); load(); refresh(); }} />
    </section>
  );
}
