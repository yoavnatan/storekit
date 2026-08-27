import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shopperStoresFrom } from '../src/lib/stores.js';

/**
 * The showcase stores stay on the demonstration's front page, and only there.
 *
 * **The rule and its one exception.** On the real platform `filterShopperStores` drops the showcase
 * stores as soon as five real LIVE stores exist: they were built to cover exactly the window before
 * that, and leaving them up afterwards would be a mall advertising its own props. On the PORTFOLIO
 * demonstration the same rule points the other way — anybody may press "פתח חנות", so five visitors
 * with five products each would push the four curated shops off the homepage and the directory, and
 * a recruiter opening the link would find whatever strangers left behind instead of the work.
 *
 * **Gated on `DEMO_MODE` and nothing else**, at the owner's instruction (2026-08-27: *"שלא יהרוס את
 * זה שאם כן מעלים את זה בסוף ונשכח מזה... תעשה שזה יהיה רק בגרסת הדמו"*). A real launch keeps the
 * behaviour it was designed with, and the exception cannot be left switched on by accident, because
 * nothing in a real deployment sets that variable.
 *
 * The second case is the one that matters in six months: the exception lives in `stores.ts` and can
 * only be lost by a page reaching past it to `filterShopperStores` again, which is exactly what both
 * pages used to do.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ORIGINAL = process.env.DEMO_MODE;

function pages(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) pages(full, acc);
    else if (/\.(astro|ts)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** Six real stores — one more than the threshold — so the un-pinned rule definitely drops the demos. */
const MALL = [
  { demo: true }, { demo: true }, { demo: true }, { demo: true },
  {}, {}, {}, {}, {}, {},
];

beforeEach(() => { delete process.env.DEMO_MODE; });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = ORIGINAL;
});

describe('the showcase stores on a shopper surface', () => {
  it('are dropped once the mall is full — the behaviour a real launch keeps', () => {
    const shown = shopperStoresFrom(MALL, 6);
    expect(shown).toHaveLength(6);
    expect(shown.some((s) => s.demo)).toBe(false);
  });

  it('are still there while the mall is thin, demo mode or not', () => {
    expect(shopperStoresFrom(MALL, 2)).toHaveLength(10);
  });

  it('are pinned in demo mode, however many real stores visitors have opened', () => {
    process.env.DEMO_MODE = '1';
    const shown = shopperStoresFrom(MALL, 6);
    expect(shown).toHaveLength(10);
    expect(shown.filter((s) => s.demo)).toHaveLength(4);
  });

  it('no page reaches past the pin to the raw rule', () => {
    // The only way the exception can be lost. Both pages called `filterShopperStores` directly
    // until 2026-08-27, which is why this is a tree scan and not a comment.
    const offenders: string[] = [];
    for (const file of pages(join(SRC, 'pages'))) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('filterShopperStores')) offenders.push(file.replace(SRC, ''));
    }
    expect(
      offenders,
      'A page calling filterShopperStores() skips the demo-mode pin in lib/stores.ts, and the\n'
      + 'demonstration silently loses its showcase stores once five visitors have built a shop.\n'
      + 'Use shopperStoresFrom() instead. Found in:\n' + offenders.join('\n'),
    ).toEqual([]);
  });
});
