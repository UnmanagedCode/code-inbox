import { describe, expect, it } from 'vitest';
import { stamp } from './format';

const at = (y: number, m: number, d: number, h = 14, min = 2) => new Date(y, m, d, h, min).getTime();
const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// Invariant: stamps compare local calendar days, and show the year only when it differs from now's.
describe('stamp', () => {
  const now = at(2025, 2, 1, 9, 0);
  it('same day is the time alone', () => expect(stamp(at(2025, 2, 1, 1, 5), now)).toBe(time(at(2025, 2, 1, 1, 5))));
  it('previous calendar day, across a month boundary', () => {
    expect(stamp(at(2025, 1, 28, 23, 59), now)).toBe(`Yesterday ${time(at(2025, 1, 28, 23, 59))}`);
  });
  it('earlier this year omits the year', () => expect(stamp(at(2025, 0, 5), now)).not.toContain('2025'));
  it('an earlier year shows it', () => expect(stamp(at(2023, 10, 3), now)).toContain('2023'));
});
