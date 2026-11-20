import type { Message } from '../types';
import { stamp, when, who } from '../format';

export const GROUP_GAP_MS = 5 * 60_000;

// Every body and name renders as React text, whoever wrote it: the local human, an agent or a peer.
// Consecutive messages from one sender within GROUP_GAP_MS share one head; `data-own` marks this install's.
export function MessageList({ messages, selfFp, now = Date.now() }: { messages: Message[]; selfFp: string; now?: number }) {
  if (messages.length === 0) return <p className="muted">No messages yet.</p>;
  return (
    <ol className="messages" aria-label="Messages">
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const continued = !!prev && prev.sender.fp === m.sender.fp && Math.abs(m.ts - prev.ts) <= GROUP_GAP_MS;
        return (
          <li key={m.id} className="message" data-own={m.sender.fp === selfFp ? '' : undefined} data-continued={continued ? '' : undefined}>
            {!continued && (
              <div className="message-head">
                <span className="sender">{who(m.sender)}</span>
                <time className="muted" dateTime={new Date(m.ts).toISOString()} title={when(m.ts)}>{stamp(m.ts, now)}</time>
              </div>
            )}
            <p className="body" title={continued ? `${who(m.sender)}, ${when(m.ts)}` : undefined}>{m.body}</p>
          </li>
        );
      })}
    </ol>
  );
}
