import { useState } from 'react';
import { api } from '../api';
import { short } from '../format';
import type { State } from '../types';
import { useAction } from '../useAction';
import { Panel } from './Panel';

// TCP and the hub have no shared directory: humans exchange contact cards (a signed announce) to find each other.
export function ContactsPanel({ state, refresh }: { state: State; refresh: () => void }) {
  const { card, cardStale } = state.transport;
  const [text, setText] = useState('');
  const [imported, setImported] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const { busy, error, run } = useAction(refresh);
  const copy = () => {
    if (!card) return;
    navigator.clipboard.writeText(card).then(() => setCopied('Copied.'), () => setCopied('Copying failed: select the card and copy it by hand.'));
  };
  return (
    <Panel title="Contacts">
      <h3>Your contact card</h3>
      {card && <textarea readOnly aria-label="Your contact card" className="mono" rows={3} value={card} />}
      {(!card || cardStale) && <p className="muted">Announce to refresh your card.</p>}
      <div className="row">
        <button type="button" disabled={!card} onClick={copy}>Copy</button>
        {copied && <span role="status" className="muted">{copied}</span>}
      </div>
      <h3>Import a contact card</h3>
      <form onSubmit={(e) => {
        e.preventDefault();
        setImported(null);
        void run(async () => {
          const r = await api.importCard(text);
          setImported(`Imported ${r.name} (${short(r.fp)})`);
          setText('');
        });
      }}>
        <label className="stack"><span>Contact card</span><textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="code-inbox-card:v1:…" /></label>
        <div className="row"><button type="submit" disabled={busy || !text.trim()}>Import</button></div>
      </form>
      {imported && <p role="status">{imported}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </Panel>
  );
}
