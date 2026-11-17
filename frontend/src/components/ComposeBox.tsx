import { useState } from 'react';
import { api, describe } from '../api';

// Sends through the same engine path as the agents' send_message. A refusal keeps the typed text and shows its
// code; a success clears it and tells the parent to reload the list.
export function ComposeBox({ inboxId, onSent }: { inboxId: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.send(inboxId, text);
      setText('');
      setError(null);
      onSent();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <label className="stack">
        <span>Message</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="row">
        <button type="submit" data-variant="primary" disabled={busy || !text}>Send</button>
      </div>
    </form>
  );
}
