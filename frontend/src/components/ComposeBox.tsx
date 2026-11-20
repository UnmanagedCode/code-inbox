import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { api, describe } from '../api';

// Unsent text per inbox, kept while the page stays open.
const drafts = new Map<string, string>();

const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;

// Sends through the same engine path as the agents' send_message. A refusal keeps the typed text and shows its
// code; a success clears it and tells the parent to reload the list. Enter sends, Shift+Enter is a newline; on a
// touch device Enter is a newline and Ctrl/⌘+Enter sends.
export function ComposeBox({ inboxId, onSent }: { inboxId: string; onSent: () => void }) {
  const [text, setText] = useState(() => drafts.get(inboxId) ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const blank = text.trim() === '';

  useEffect(() => { if (!coarsePointer()) area.current?.focus(); }, []);
  // Grow with the content; the CSS max-height caps it and the textarea scrolls beyond.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [text]);

  async function send() {
    if (blank || busy) return;
    setBusy(true);
    try {
      await api.send(inboxId, text);
      drafts.delete(inboxId);
      setText('');
      setError(null);
      onSent();
      area.current?.focus();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="compose-row">
        <textarea ref={area} aria-label="Message" aria-describedby={hintId} placeholder="Write a message" rows={1} value={text}
          onChange={(e) => { setText(e.target.value); drafts.set(inboxId, e.target.value); }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            if (e.ctrlKey || e.metaKey || (!e.shiftKey && !e.altKey && !coarsePointer())) { e.preventDefault(); void send(); }
          }} />
        <button type="submit" data-variant="primary" disabled={busy || blank}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
      <p id={hintId} className="muted compose-hint">Enter to send · Shift+Enter for a new line</p>
    </form>
  );
}
