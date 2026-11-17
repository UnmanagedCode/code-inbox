import type { Message } from '../types';
import { when, who } from '../format';

// Every body and name renders as React text, whoever wrote it: the local human, an agent or a peer.
export function MessageList({ messages }: { messages: Message[] }) {
  if (messages.length === 0) return <p className="muted">No messages yet.</p>;
  return (
    <ol className="messages" aria-label="Messages">
      {messages.map((m) => (
        <li key={m.id} className="message">
          <div className="message-head">
            <span className="sender">{who(m.sender)}</span>
            <span className="muted">{when(m.ts)}</span>
          </div>
          <p className="body">{m.body}</p>
        </li>
      ))}
    </ol>
  );
}
