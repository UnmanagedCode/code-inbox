import { useState } from 'react';
import { describe } from './api';

// Runs one human action at a time: `error` holds its refusal ("CODE: message"), `after` reloads the view.
export function useAction(after: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      setError(null);
      after();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
