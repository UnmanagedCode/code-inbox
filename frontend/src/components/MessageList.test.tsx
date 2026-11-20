import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { GROUP_GAP_MS, MessageList } from './MessageList';
import type { Message } from '../types';

const HOSTILE = ['<img src=x onerror=alert(1)>', 'javascript:alert(1)', '<script>alert(1)</script>', '<a href="javascript:alert(1)">click</a>'];
const SELF = 'a'.repeat(64);
const T0 = 1_700_000_000_000;
const msg = (body: string, i: number, name: string | null = '<b>mallory</b>'): Message => ({
  id: `id${i}`, seq: i + 1, ts: 1_700_000_000_000, body, sender: { fp: `${i}`.repeat(64).slice(0, 64), name },
});

// Invariant: peer-written bodies and names become literal text, never markup or a link.
describe('MessageList', () => {
  it('renders hostile bodies and names as literal text', () => {
    const { container } = render(<MessageList messages={HOSTILE.map((b, i) => msg(b, i))} selfFp={SELF} />);
    const items = within(screen.getByRole('list', { name: 'Messages' })).getAllByRole('listitem');
    expect(items).toHaveLength(HOSTILE.length);
    HOSTILE.forEach((b, i) => expect(items[i].querySelector('.body')?.textContent).toBe(b));
    expect(container.querySelectorAll('img, script, a, b, iframe')).toHaveLength(0);
    expect(screen.getAllByText(/<b>mallory<\/b>/)).toHaveLength(HOSTILE.length);
  });

  it('shows a sender whose name is not shown by fingerprint', () => {
    render(<MessageList messages={[msg('hi', 7, null)]} selfFp={SELF} />);
    expect(screen.getByText(`[${'7'.repeat(16)}]`)).toBeTruthy();
  });

  const from = (fp: string, name: string, ts: number, body: string, i: number): Message => ({ id: `g${i}`, seq: i, ts, body, sender: { fp: fp.repeat(64), name } });

  // Invariant: a sender's consecutive messages within GROUP_GAP_MS share one head; a gap beyond it or another
  // sender starts a new one; every body still renders.
  it('groups consecutive messages from one sender', () => {
    const msgs = [
      from('b', 'bob', T0, 'one', 1),
      from('b', 'bob', T0 + 60_000, 'two', 2),
      from('c', 'carol', T0 + 90_000, 'three', 3),
      from('b', 'bob', T0 + 120_000, 'four', 4),
      from('b', 'bob', T0 + 120_000 + GROUP_GAP_MS + 1, 'five', 5),
    ];
    render(<MessageList messages={msgs} selfFp={SELF} now={T0} />);
    expect(screen.getAllByText(/^bob \[/)).toHaveLength(3);
    expect(screen.getAllByText(/^carol \[/)).toHaveLength(1);
    ['one', 'two', 'three', 'four', 'five'].forEach((b) => expect(screen.getByText(b)).toBeTruthy());
  });

  // Invariant: data-own marks exactly this install's messages (the styling contract for "own").
  it('marks own messages', () => {
    render(<MessageList messages={[from('a', 'alice', T0, 'mine', 1), from('b', 'bob', T0 + 1, 'theirs', 2)]} selfFp={SELF} now={T0} />);
    const [mine, theirs] = screen.getAllByRole('listitem');
    expect(mine.hasAttribute('data-own')).toBe(true);
    expect(theirs.hasAttribute('data-own')).toBe(false);
  });

  // Invariant: each head's <time> carries the exact instant machine-readably.
  it('time elements carry the message instant', () => {
    const msgs = [from('b', 'bob', T0, 'x', 1), from('c', 'carol', T0 + 5000, 'y', 2)];
    const { container } = render(<MessageList messages={msgs} selfFp={SELF} now={T0} />);
    const times = [...container.querySelectorAll('time')].map((t) => Date.parse(t.getAttribute('datetime')!));
    expect(times).toEqual([T0, T0 + 5000]);
  });

  // Invariant: a gap of exactly GROUP_GAP_MS still groups (the boundary is inclusive).
  it('groups at exactly GROUP_GAP_MS', () => {
    render(<MessageList messages={[from('b', 'bob', T0, 'one', 1), from('b', 'bob', T0 + GROUP_GAP_MS, 'two', 2)]} selfFp={SELF} now={T0} />);
    expect(screen.getAllByText(/^bob \[/)).toHaveLength(1);
  });
});
