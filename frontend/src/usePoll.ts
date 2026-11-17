import { useEffect, useRef } from 'react';

// Runs `fn` now and every `ms` while the page is visible (and once more when it becomes visible again).
export function usePoll(fn: () => void, ms: number, deps: unknown[]) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const run = () => { if (document.visibilityState !== 'hidden') latest.current(); };
    run();
    const id = setInterval(run, ms);
    document.addEventListener('visibilitychange', run);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', run); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}
