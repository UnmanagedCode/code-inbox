import type { Person } from './types';

// How a person is shown: the announced name when this install shows it, plus a short fingerprint either way.
export const short = (fp: string) => fp.slice(0, 16);
export const who = (p: Person) => (p.name ? `${p.name} [${short(p.fp)}]` : `[${short(p.fp)}]`);
export const when = (ts: number) => new Date(ts).toLocaleString();
