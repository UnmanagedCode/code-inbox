import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export const NEAR_BOTTOM_PX = 48; // "at the latest" tolerance: sub-pixel rounding, a partly visible last entry

// Keeps a scroll container at its newest entry: opens there, stays there while the reader is there, and holds the
// reader's place (flagging `fresh`) when they scrolled up. `lastKey` identifies the newest entry.
export function useStickToBottom(lastKey: string | null) {
  const ref = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const prevKey = useRef(lastKey);
  const clientH = useRef<number | null>(null); // the viewport height the last scroll/resize was judged at
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
    // A scroll that arrives with a changed viewport height is the browser clamping to a layout change (the header
    // grew, the composer grew), not the reader leaving the latest: leave the verdict to the resize re-pin.
    const h = el.clientHeight;
    const resized = clientH.current !== null && clientH.current !== h;
    clientH.current = h;
    if (resized) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    atBottom.current = near;
    setAway(!near);
    if (near) setFresh(false);
  }, []);

  useLayoutEffect(() => {
    if (lastKey === prevKey.current) return; // the mount run: nothing arrived yet
    prevKey.current = lastKey;
    if (atBottom.current) toLatest();
    else if (lastKey !== null) setFresh(true);
  }, [lastKey, toLatest]);

  // Window resizes, mobile keyboards and a growing composer change the viewport height: re-pin while at the latest.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      clientH.current = el.clientHeight;
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Own send: scroll now (a poll may already have delivered the sent message while the reader was away, so no
  // later lastKey change would follow) and keep following the newest entry.
  const stickNext = toLatest;
  return { ref: ref as RefObject<HTMLDivElement | null>, onScroll, away, fresh, toLatest, stickNext };
}
