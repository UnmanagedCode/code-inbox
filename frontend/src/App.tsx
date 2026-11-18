import { useCallback, useEffect, useState } from 'react';
import { api, describe } from './api';
import type { State } from './types';
import { usePoll } from './usePoll';
import { ContactsPanel } from './components/ContactsPanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { DirectoryPanel } from './components/DirectoryPanel';
import { IdentityPanel } from './components/IdentityPanel';
import { InboxList } from './components/InboxList';
import { InboxView, POLL_MS } from './components/InboxView';
import { InvitesPanel } from './components/InvitesPanel';
import { NotificationsPanel } from './components/NotificationsPanel';
import { TransportPanel } from './components/TransportPanel';

// The page is routed by its query string: `?inbox=<id>` opens one inbox; no query shows the overview.
const inboxFromLocation = () => new URLSearchParams(window.location.search).get('inbox');

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inboxId, setInboxId] = useState<string | null>(inboxFromLocation);
  const refresh = useCallback(() => {
    api.state().then((s) => { setState(s); setError(null); }, (e) => setError(describe(e)));
  }, []);
  usePoll(refresh, POLL_MS, []);
  useEffect(() => {
    const onPop = () => setInboxId(inboxFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const open = (id: string | null) => {
    window.history.pushState(null, '', id ? `?inbox=${encodeURIComponent(id)}` : '?');
    setInboxId(id);
  };

  if (!state) return <main className="page">{error ? <p role="alert" className="error">{error}</p> : <p className="muted">Loading…</p>}</main>;
  const inbox = inboxId ? state.inboxes.find((b) => b.id === inboxId) : undefined;
  return (
    <main className="page">
      <h1>Code Inbox</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {inboxId ? (
        inbox ? <InboxView inbox={inbox} state={state} refresh={refresh} back={() => open(null)} />
          : <section className="panel"><p className="muted">This install is not a party or member of that inbox.</p><button type="button" onClick={() => open(null)}>← Inboxes</button></section>
      ) : (
        <>
          <InboxList inboxes={state.inboxes} selfFp={state.identity.fp} open={open} />
          <InvitesPanel state={state} refresh={refresh} />
          <DirectoryPanel state={state} refresh={refresh} />
          <IdentityPanel state={state} refresh={refresh} />
          <TransportPanel state={state} refresh={refresh} />
          {state.transport.kind === 'network' && <ContactsPanel state={state} refresh={refresh} />}
          <NotificationsPanel state={state} refresh={refresh} />
          <DiagnosticsPanel diagnostics={state.diagnostics} />
        </>
      )}
    </main>
  );
}
