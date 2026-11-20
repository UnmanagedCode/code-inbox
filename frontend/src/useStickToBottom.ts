import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export const NEAR_BOTTOM_PX = 48; // "at the latest" tolerance: sub-pixel rounding, a partly visible last entry

// Keeps a scroll container at its newest entry: opens there, stays there while the reader is there, and holds the
// reader's place (flagging `fresh`) when they scrolled up. `lastKey` identifies the newest entry.
export function useStickToBottom(lastKey: string | null) {
  const ref = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const prevKey = useRef(lastKey);
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);

  const toLatest = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setAway(false);
    setFresh(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    atBottom.current = near;
    setAway(!near);
    if (near) setFresh(false);
  }, []);

  useLayoutEffect(() => {
    if (lastKey === prevKey.current) return;
    prevKey.current = lastKey;
    if (atBottom.current) toLatest();
    else if (lastKey !== null) setFresh(true);
  }, [lastKey, toLatest]);

  // Window resizes, mobile keyboards and a growing composer change the viewport height: re-pin while at the latest.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const stickNext = useCallback(() => { atBottom.current = true; }, []);
  return { ref: ref as RefObject<HTMLDivElement | null>, onScroll, away, fresh, toLatest, stickNext };
}
