import type { Inbox } from '../types';
import { short } from '../format';
import { Panel } from './Panel';

// A personal inbox is named after the other party; while that party's name is not shown, by its fingerprint.
export const inboxLabel = (b: Inbox, selfFp: string) => b.name ?? `[${short(b.members.find((m) => m.fp !== selfFp)?.fp ?? b.id)}]`;

export function InboxList({ inboxes, selfFp, open }: { inboxes: Inbox[]; selfFp: string; open: (id: string) => void }) {
  return (
    <Panel title="Inboxes">
      {inboxes.length === 0 ? <p className="muted">No inbox yet: accept an invite, invite someone, or create a shared inbox.</p> : (
        <ul className="list">
          {inboxes.map((b) => (
            <li key={b.id} className="row">
              <button type="button" data-variant="ghost" className="grow left" onClick={() => open(b.id)}>
                <strong>{inboxLabel(b, selfFp)}</strong> <span className="muted">{b.kind}, {b.members.length} members</span>
              </button>
              {b.unread > 0 && <span className="badge" aria-label={`${b.unread} unread`}>{b.unread}</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
