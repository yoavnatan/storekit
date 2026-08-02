/**
 * The combo table's "total" row, and the one rule behind it.
 *
 * The number is: the counted buckets added up, PLUS the shared pool exactly once if any combo is
 * still drawing on it. Once — the pool is a single quantity every uncounted combo shares, so adding
 * it per row would report stock that does not exist, and leaving it out reports a stocked product
 * as empty (which is what "total 0" after a save was).
 *
 * Three places render this table — the SSR edit row (seller/dashboard.astro), the client editor
 * (scripts/dashboard/products.ts) and the table it rebuilds after a save — and the rule has now
 * drifted between them twice. These tests pin the arithmetic, and the source checks below pin the
 * wiring: a builder that forgets `updateComboTotal` leaves the template's literal 0 on screen, and
 * nothing else notices.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { comboStockRows, sumComboOverrides, comboKey } from '../src/lib/variant-combo.js';

const DIMS = [{ name: 'צבע', options: ['אדום', 'כחול'] }];
const RED = comboKey({ צבע: 'אדום' });
const BLUE = comboKey({ צבע: 'כחול' });

/** The shared rule, written once here exactly as both renderers implement it. */
function comboTotal(variantStock: Record<string, number> | undefined, pool: number): number {
  const rows = comboStockRows(DIMS, variantStock, pool);
  return sumComboOverrides(variantStock) + (rows.some((r) => r.shared) ? pool : 0);
}

describe('the combo total', () => {
  it('is the pool itself when nothing has been counted', () => {
    // Two pooled combos sharing 10 units is 10 — not 20, and not 0.
    expect(comboTotal(undefined, 10)).toBe(10);
  });

  it('adds the pool once, not once per pooled combo', () => {
    const three = [{ name: 'צבע', options: ['אדום', 'כחול', 'ירוק'] }];
    const rows = comboStockRows(three, undefined, 6);
    expect(rows).toHaveLength(3);
    expect(sumComboOverrides(undefined) + (rows.some((r) => r.shared) ? 6 : 0)).toBe(6);
  });

  it('adds a counted bucket to the pool the others still share', () => {
    // Red counted at 4; blue still pooled against 7 → 11 sellable.
    expect(comboTotal({ [RED]: 4 }, 7)).toBe(11);
  });

  it('drops the pool once every combo has been counted', () => {
    // Nothing sells from the pool any more, so it stops counting — 4 + 2, not 4 + 2 + 7.
    expect(comboTotal({ [RED]: 4, [BLUE]: 2 }, 7)).toBe(6);
  });

  it('counts an explicit zero as counted, not as pooled', () => {
    // Red is sold out and blue is pooled: 0 + 5.
    expect(comboTotal({ [RED]: 0 }, 5)).toBe(5);
    // Both explicitly zero → genuinely nothing to sell, even with a nonzero (now unused) pool.
    expect(comboTotal({ [RED]: 0, [BLUE]: 0 }, 9)).toBe(0);
  });
});

describe('every renderer of the table computes its total', () => {
  const CLIENT = readFileSync(resolve(process.cwd(), 'src/scripts/dashboard/products.ts'), 'utf8');
  const SSR = readFileSync(resolve(process.cwd(), 'src/pages/seller/dashboard.astro'), 'utf8');

  it('rebuilds the rows and the total together, never one without the other', () => {
    // comboRowsHtml() writes the rows; comboTotalRowHtml() writes a placeholder 0 that only
    // updateComboTotal() replaces. Every builder must call it — this is the assertion that would
    // have caught the "total 0 after saving" report.
    const builders = CLIENT.match(/comboRowsHtml\(/g) ?? [];
    const totals = CLIENT.match(/updateComboTotal\(/g) ?? [];
    expect(builders.length).toBeGreaterThan(0);
    // One definition + one call per builder, at minimum.
    expect(totals.length).toBeGreaterThan(builders.length);
  });

  it('does not leave the SSR total as a bare sum of the buckets', () => {
    // The bug: `reduce((s, c) => s + (c.value ?? 0), 0)` silently drops the pool, so a product
    // whose combos are all pooled rendered a total of 0 on first paint.
    expect(SSR).not.toMatch(/reduce\(\(s, c\) => s \+ \(c\.value \?\? 0\), 0\)/);
    expect(SSR).toContain('pComboTotal');
  });
});
