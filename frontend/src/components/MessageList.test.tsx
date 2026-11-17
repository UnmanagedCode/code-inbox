import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MessageList } from './MessageList';
import type { Message } from '../types';

const HOSTILE = ['<img src=x onerror=alert(1)>', 'javascript:alert(1)', '<script>alert(1)</script>', '<a href="javascript:alert(1)">click</a>'];
const msg = (body: string, i: number, name: string | null = '<b>mallory</b>'): Message => ({
  id: `id${i}`, seq: i + 1, ts: 1_700_000_000_000, body, sender: { fp: `${i}`.repeat(64).slice(0, 64), name },
});

// Invariant: peer-written bodies and names become literal text, never markup or a link.
describe('MessageList', () => {
  it('renders hostile bodies and names as literal text', () => {
    const { container } = render(<MessageList messages={HOSTILE.map((b, i) => msg(b, i))} />);
    const items = within(screen.getByRole('list', { name: 'Messages' })).getAllByRole('listitem');
    expect(items).toHaveLength(HOSTILE.length);
    HOSTILE.forEach((b, i) => expect(items[i].querySelector('.body')?.textContent).toBe(b));
    expect(container.querySelectorAll('img, script, a, b, iframe')).toHaveLength(0);
    expect(screen.getAllByText(/<b>mallory<\/b>/)).toHaveLength(HOSTILE.length);
  });

  it('shows a sender whose name is not shown by fingerprint', () => {
    render(<MessageList messages={[msg('hi', 7, null)]} />);
    expect(screen.getByText(`[${'7'.repeat(16)}]`)).toBeTruthy();
  });
});
