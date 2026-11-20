import type { Person } from './types';

// How a person is shown: the announced name when this install shows it, plus a short fingerprint either way.
export const short = (fp: string) => fp.slice(0, 16);
export const who = (p: Person) => (p.name ? `${p.name} [${short(p.fp)}]` : `[${short(p.fp)}]`);
export const when = (ts: number) => new Date(ts).toLocaleString();

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const HOUR_MIN = { hour: '2-digit', minute: '2-digit' } as const;

// A compact stamp relative to `now`, compared by local calendar day (never by subtracting 24 h: DST days are not 24 h).
export function stamp(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const time = d.toLocaleTimeString(undefined, HOUR_MIN);
  if (sameDay(d, n)) return time;
  const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${time}`;
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() === n.getFullYear() ? {} : { year: 'numeric' }), ...HOUR_MIN });
}
