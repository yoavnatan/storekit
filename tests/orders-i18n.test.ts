/**
 * The orders tab renders in the seller's language — all of it.
 *
 * The order card has two renderers (SSR in seller/dashboard.astro, and the
 * client rebuild here) and the client one was written with its strings inline in
 * Hebrew: "מוצר אחד", "לקוח", "טלפון:", the cancel-confirm, the new-order toast,
 * the whole edit-order modal, and an age chip pinned to `'he'`. Switching the
 * dashboard to English produced an English shell around Hebrew order cards, and
 * nothing failed — it just read as broken (owner, 2026-07-31).
 *
 * Two rules, both cheap to keep: no language literals in the module, and every
 * key it asks for actually exists in BOTH dictionaries — a typo'd key is not a
 * type error at runtime, it renders an empty string.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { translations } from '../src/i18n/translations.js';
import { ORDER_FILTER_STATUSES } from '../src/lib/seller-orders-query.js';

const SOURCE = readFileSync(join(process.cwd(), 'src/scripts/dashboard/orders.ts'), 'utf8');

/** The file minus its comments — Hebrew is welcome there and nowhere else. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('orders tab i18n', () => {
  it('carries no language literals in the code itself', () => {
    const offenders = CODE.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => /[֐-׿]/.test(l.line));
    expect(offenders.map((o) => `${o.n}: ${o.line.slice(0, 80)}`)).toEqual([]);
  });

  it('only asks for keys both languages define', () => {
    const keys = [...SOURCE.matchAll(/\btt\('(\w+)'/g)].map((m) => m[1]);
    expect(keys.length, 'the tt() accessor should be how this module reads its strings').toBeGreaterThan(20);

    const he = translations.he.dashboard as unknown as Record<string, string>;
    const en = translations.en.dashboard as unknown as Record<string, string>;
    const missing = [...new Set(keys)].filter((k) => !he[k] || !en[k]);
    expect(missing).toEqual([]);
  });

  /**
   * Every status the filter menu can offer has a NAME, in both renderers.
   *
   * `ORDER_FILTER_STATUSES` is generated from the status table so a new status is filterable the
   * day it is added — which is the right design and is exactly what made this fail silently:
   * `returned` became filterable and neither label map knew it, so the menu rendered `?? value`
   * and put the raw English word next to "בוטלה". Two rows that read as the same thing, one of
   * them untranslated, on a Hebrew screen (owner, 2026-08-20).
   *
   * Checked against the SOURCE of both renderers rather than by importing the maps: they are
   * function-local in the client bundle and frontmatter consts in the `.astro`, and neither is
   * reachable from a test. What matters is that the key is there.
   */
  it('names every filterable shipping status, in both renderers', () => {
    const ssr = readFileSync(join(process.cwd(), 'src/pages/seller/dashboard.astro'), 'utf8');
    const labelBlock = (src: string, marker: string): string => {
      const at = src.indexOf(marker);
      expect(at, `${marker} not found — the label map was renamed`).toBeGreaterThan(-1);
      return src.slice(at, src.indexOf('};', at));
    };
    const clientLabels = labelBlock(SOURCE, 'const labelMap: Record<string, string> = {');
    const ssrLabels = labelBlock(ssr, 'const orderShippingLabels: Record<string, string> = {');
    const ssrColors = labelBlock(ssr, 'const orderStatusColors: Record<string, string> = {');

    for (const status of ORDER_FILTER_STATUSES) {
      expect(clientLabels, `${status}: the client renderer would print the raw English word`)
        .toMatch(new RegExp(`\\b${status}\\s*:`));
      expect(ssrLabels, `${status}: the server renderer would print the raw English word`)
        .toMatch(new RegExp(`\\b${status}\\s*:`));
      expect(ssrColors, `${status}: no colour, so its badge falls back to grey`)
        .toMatch(new RegExp(`\\b${status}\\s*:`));
    }
  });

  it('keeps the {n} placeholder in every counted string', () => {
    // tt(key, n) does a plain `{n}` replace — a translation that dropped the
    // placeholder silently loses the number instead of failing.
    const he = translations.he.dashboard as unknown as Record<string, string>;
    const en = translations.en.dashboard as unknown as Record<string, string>;
    for (const key of ['orderNewCount', 'orderProductsMany']) {
      expect(he[key], `he.${key}`).toContain('{n}');
      expect(en[key], `en.${key}`).toContain('{n}');
    }
  });

  it('takes the age chip language from the page, not a constant', () => {
    // The chip builds its own wording, so a pinned 'he' put Hebrew inside an
    // otherwise-English card — the one string the key sweep above cannot see.
    expect(SOURCE).not.toMatch(/orderAgeChipHtml\([^)]*,\s*'he'\s*\)/);
    expect(SOURCE).toMatch(/const ordersLang\s*=/);
  });
});
