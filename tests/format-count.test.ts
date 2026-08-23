/**
 * `compactCount` — the shortening that lets a column be sized for its worst case.
 *
 * Two kinds of assertion here, and the second kind is the reason this file matters more than its
 * size suggests. The first is the output itself. The second is the two places this function must
 * NEVER reach: money, and stock. Both are grep assertions over the real source, because both
 * failures are additions a future change makes by accident — a shortened figure looks like a
 * tidier column right up until the moment it is the number someone acts on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compactCount, isCompacted } from '../src/lib/format-count.js';

describe('compactCount', () => {
  it('leaves anything under a thousand exactly as it is', () => {
    for (const n of [0, 1, 7, 42, 99, 100, 999]) expect(compactCount(n)).toBe(String(n));
  });

  it('shortens from a thousand up, keeping a decimal only while it says something', () => {
    expect(compactCount(1000)).toBe('1.0K');
    expect(compactCount(1234)).toBe('1.2K');
    expect(compactCount(9999)).toBe('9.9K');
    expect(compactCount(12345)).toBe('12K');
    expect(compactCount(123456)).toBe('123K');
    expect(compactCount(1234567)).toBe('1.2M');
    expect(compactCount(12345678)).toBe('12M');
    expect(compactCount(1234567890)).toBe('1.2B');
  });

  it('rounds DOWN, never up — a count is a floor, and 999,999 must not read as a million', () => {
    expect(compactCount(1999)).toBe('1.9K');
    expect(compactCount(999999)).toBe('999K');
  });

  /**
   * The property the column widths are built on (dashboard.css): five characters, whatever the
   * input. A column sized to five characters is either always enough or the sizing is a lie.
   */
  it('never returns more than five characters, for any input', () => {
    const cases = [0, 1, 999, 1000, 9999, 99999, 999999, 9999999, 1e12, Number.MAX_SAFE_INTEGER];
    for (const n of cases) expect(compactCount(n).length, `for ${n}`).toBeLessThanOrEqual(5);
  });

  it('treats nonsense as nothing rather than rendering it', () => {
    for (const n of [-1, -1000, NaN, Infinity, -Infinity]) expect(compactCount(n)).toBe('0');
  });

  it('isCompacted agrees with when digits are actually hidden', () => {
    expect(isCompacted(999)).toBe(false);
    expect(isCompacted(1000)).toBe(true);
    for (const n of [0, 1, 999, 1000, 5000, 123456]) {
      expect(isCompacted(n), `for ${n}`).toBe(compactCount(n) !== String(n));
    }
  });
});

describe('where it must never be used', () => {
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

  /**
   * **Stock is edited in place, from the cell's own text.** `products.ts` reads `prevStock` out of
   * `valueEl.textContent` and posts it as the optimistic-concurrency check on an inventory write;
   * `Number('12K')` is NaN and `|| 0` of that is zero. A shortened stock total is therefore not a
   * display choice, it is a wrong number sent to the server about how much of something exists.
   */
  it('never renders the stock total', () => {
    const products = read('src/scripts/dashboard/products.ts');
    const stockHtml = products.slice(products.indexOf('function stockHtml'), products.indexOf('function stockHtml') + 800);
    expect(stockHtml).not.toContain('compactCount');
    // The other renderer of the same row.
    const page = read('src/pages/seller/dashboard.astro');
    const cell = page.slice(page.indexOf('data-stock-total'), page.indexOf('data-stock-total') + 1200);
    expect(cell).not.toContain('compactCount');
  });

  /** Money has one formatter and it does not approximate — `lib/money.ts`, and the money guards
   *  scan the tree for anything that sets up a second one. */
  it('is not reachable from the money modules', () => {
    for (const f of ['src/lib/money.ts', 'src/lib/orders.ts', 'src/lib/refund-owed.ts']) {
      expect(read(f), f).not.toContain('format-count');
    }
  });

  /** Both renderers of the products row have to agree, or the table changes shape when a filter
   *  rebuilds it — memory `project_client_renderer_i18n_drift`. */
  it('is used by BOTH renderers of the products row, or by neither', () => {
    const client = read('src/scripts/dashboard/products.ts');
    const server = read('src/pages/seller/dashboard.astro');
    // `<td class="num X" style=` and not `class="num X"` alone: the same class names the sortable
    // `<th>`, which comes first in the file and is not what renders the number.
    for (const col of ['wishlist-col', 'purchased-col']) {
      const needle = `class="num ${col}" style=`;
      const c = client.slice(client.indexOf(needle), client.indexOf(needle) + 1200);
      const s = server.slice(server.indexOf(needle), server.indexOf(needle) + 1200);
      expect(client, `client ${col} cell`).toContain(needle);
      expect(server, `server ${col} cell`).toContain(needle);
      expect(c, `client ${col}`).toContain('compactCount');
      expect(s, `server ${col}`).toContain('compactCount');
    }
  });
});
