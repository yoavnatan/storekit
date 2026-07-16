import { describe, expect, it } from 'vitest';
import { countSince } from '../src/lib/admin-tab-views.js';

describe('countSince', () => {
  it('counts only items created strictly after the given timestamp', () => {
    const items = [
      { createdAt: '2026-01-01T00:00:00.000Z' },
      { createdAt: '2026-01-05T00:00:00.000Z' },
      { createdAt: '2026-01-10T00:00:00.000Z' },
    ];
    const count = countSince(items, '2026-01-04T00:00:00.000Z', (i) => i.createdAt);
    expect(count).toBe(2);
  });

  it('returns 0 when nothing was created after the timestamp', () => {
    const items = [{ createdAt: '2026-01-01T00:00:00.000Z' }];
    expect(countSince(items, '2026-01-05T00:00:00.000Z', (i) => i.createdAt)).toBe(0);
  });
});
