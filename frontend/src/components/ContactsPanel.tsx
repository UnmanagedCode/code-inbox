import { useState } from 'react';
import { api } from '../api';
import { short } from '../format';
import type { State } from '../types';
import { useAction } from '../useAction';
import { Panel } from './Panel';

// A contact card is a signed announce: it says who someone is, not where. Importing one makes that identity a contact
// (dialed through a hub that has it, or reached over a connection); routes come from the Transport panel.
export function ContactsPanel({ state, refresh }: { state: State; refresh: () => void }) {
  const { card } = state.transport;
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
      {!card && <p className="muted">Announce to create your card.</p>}
      <div className="row">
        <button type="button" disabled={!card} onClick={copy}>Copy</button>
        {copied && <span role="status" className="muted">{copied}</span>}
      </div>
      <h3>Import a contact card</h3>
      <p className="muted">A card says who someone is, not where they are: add a connection (Transport) to reach them.</p>
      <form onSubmit={(e) => {
        e.preventDefault();
        setImported(null);
        void run(async () => {
          const r = await api.importCard(text);
          setImported(`Imported ${r.name} (${short(r.fp)})`);
          setText('');
        });
      }}>
        <label className="stack"><span>Contact card</span><textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="code-inbox-card:v2:…" /></label>
        <div className="row"><button type="submit" disabled={busy || !text.trim()}>Import</button></div>
      </form>
      {imported && <p role="status">{imported}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </Panel>
  );
}
