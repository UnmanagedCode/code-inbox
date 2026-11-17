import type { State } from '../types';
import { when } from '../format';
import { Panel } from './Panel';

export function DiagnosticsPanel({ diagnostics }: { diagnostics: State['diagnostics'] }) {
  return (
    <Panel title="Diagnostics">
      <dl className="facts">
        <dt>Rejected records</dt><dd>{diagnostics.rejected} (since this backend started)</dd>
        <dt>Hidden messages</dt><dd>{diagnostics.hidden.length} (no longer valid: a decline, a removal)</dd>
        <dt>Pending records</dt><dd>{diagnostics.pending} (waiting for a record they depend on)</dd>
        <dt>Outbox</dt><dd>{diagnostics.outbox} (not yet delivered)</dd>
      </dl>
      {diagnostics.recent.length > 0 && (
        <ul className="list">
          {diagnostics.recent.map((r, i) => (
            <li key={`${r.at}-${i}`} className="mono">{when(r.at)} {r.reason}{r.detail ? `: ${r.detail}` : ''}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
