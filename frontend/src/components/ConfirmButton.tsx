import { useState } from 'react';

// A destructive action in two clicks: the first shows `confirmLabel` and Cancel inline and sends nothing; Confirm
// calls `onConfirm` once; Cancel restores the button.
export function ConfirmButton({ label, confirmLabel, disabled = false, onConfirm }: { label: string; confirmLabel: string; disabled?: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button type="button" data-variant="destructive" disabled={disabled} onClick={() => setAsking(true)}>{label}</button>;
  return (
    <span className="row">
      <button type="button" data-variant="destructive" disabled={disabled} onClick={() => { setAsking(false); onConfirm(); }}>{confirmLabel}</button>
      <button type="button" data-variant="ghost" onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
}
