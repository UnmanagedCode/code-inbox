import { afterEach, describe, expect, it } from 'vitest';
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

  // Invariant: "Yesterday" is the previous calendar day, not "within 48 h": two calendar days back stays dated
  // even when the message is under 48 h old.
  it('two calendar days back under 48 h is not Yesterday', () => {
    const ts = at(2025, 1, 27, 23, 59);
    const n = at(2025, 2, 1, 9, 0);
    expect(n - ts).toBeLessThan(48 * 3_600_000);
    expect(stamp(ts, n)).not.toMatch(/^Yesterday/);
  });

  // Invariant: yesterday across a year boundary is still Yesterday, with no year shown.
  it('yesterday across a year boundary', () => {
    expect(stamp(at(2024, 11, 31, 22, 0), at(2025, 0, 1, 9, 0))).toBe(`Yesterday ${time(at(2024, 11, 31, 22, 0))}`);
  });

  // Invariant: a 23 h DST day does not break the calendar-day comparison (now minus 24 h would land two days back).
  describe('on a spring-forward day', () => {
    const tz = process.env.TZ;
    afterEach(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
    it('the previous local day is Yesterday', () => {
      process.env.TZ = 'America/New_York';
      const ts = at(2025, 2, 9, 12, 0);
      const n = at(2025, 2, 10, 0, 30);
      expect(stamp(ts, n)).toBe(`Yesterday ${time(ts)}`);
    });
  });
});
