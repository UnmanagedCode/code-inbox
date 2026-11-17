import { useCallback, useState } from 'react';
import { api, describe } from '../api';
import type { Session, State } from '../types';
import { when } from '../format';
import { useAction } from '../useAction';
import { usePoll } from '../usePoll';
import { Panel } from './Panel';

const SESSIONS_POLL_MS = 10_000;

export function NotificationsPanel({ state, refresh }: { state: State; refresh: () => void }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [autoStart, setAutoStart] = useState<boolean | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.sessions().then((r) => { setSessions(r.sessions); setAutoStart(r.autoStart); setListError(null); }, (e) => setListError(describe(e)));
  }, []);
  usePoll(load, SESSIONS_POLL_MS, []);
  const { busy, error, run } = useAction(() => { refresh(); load(); });
  const { notify } = state;
  const targetRow = sessions?.find((s) => s.sessionId === notify.target?.sessionId);
  return (
    <Panel title="Notifications">
      <dl className="facts">
        <dt>Target</dt><dd>{notify.target ? `${notify.target.label} (${targetRow ? targetRow.status : 'not listed'})` : 'none'}</dd>
        <dt>Auto-start</dt><dd>{autoStart === null ? 'unknown' : autoStart ? 'on' : 'off'}{notify.autoStart && !notify.autoStart.ok ? ` (enabling failed: ${notify.autoStart.code}: ${notify.autoStart.error})` : ''}</dd>
        <dt>Owed</dt><dd>{notify.owed} message(s) not yet announced</dd>
        <dt>Last delivery</dt><dd>{notify.lastDelivery ? `${when(notify.lastDelivery.at)}: ${notify.lastDelivery.count} message(s)` : '—'}</dd>
        {notify.lastError && <><dt>Waiting</dt><dd>{notify.lastError.reason}</dd></>}
      </dl>
      {listError && <p role="alert" className="error">{listError}</p>}
      {sessions && (sessions.length === 0 ? <p className="muted">No top-level conductor session is running.</p> : (
        <ul className="list">
          {sessions.map((s) => (
            <li key={s.sessionId} className="row">
              <span className="grow">{s.label} <span className="muted">({s.status})</span></span>
              <button type="button" disabled={busy || s.sessionId === notify.target?.sessionId} onClick={() => void run(() => api.setNotify(s.sessionId))}>Notify this conductor</button>
            </li>
          ))}
        </ul>
      ))}
      {notify.target && <div className="row"><button type="button" disabled={busy} onClick={() => void run(() => api.setNotify(null))}>Stop notifying</button></div>}
      {error && <p role="alert" className="error">{error}</p>}
    </Panel>
  );
}
