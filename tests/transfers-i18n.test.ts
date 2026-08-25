/**
 * The transfer strip renders in the seller's language, and asks only for keys that exist.
 *
 * Same two rules as `orders-i18n.test.ts`, for the same reason: this is a client renderer, so a
 * Hebrew literal in it survives a language switch and a typo'd key renders an empty string with no
 * error anywhere. On this particular strip an empty string is a money label that vanished.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { translations } from '../src/i18n/translations.js';

const SOURCE = readFileSync(join(process.cwd(), 'src/scripts/dashboard/transfers.ts'), 'utf8');
/** The file minus its comments — Hebrew is welcome there and nowhere else. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('transfer strip i18n', () => {
  it('carries no language literals in the code itself', () => {
    const offenders = CODE.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => /[֐-׿]/.test(l.line));
    expect(offenders.map((o) => `${o.n}: ${o.line.slice(0, 80)}`)).toEqual([]);
  });

  it('only asks for keys both languages define', () => {
    const keys = [...SOURCE.matchAll(/\btt\('(\w+)'\)/g)].map((m) => m[1]!);
    expect(keys.length, 'tt() should be how this module reads its strings').toBeGreaterThan(4);

    const he = translations.he.dashboard as unknown as Record<string, string>;
    const en = translations.en.dashboard as unknown as Record<string, string>;
    expect([...new Set(keys)].filter((k) => !he[k] || !en[k])).toEqual([]);
  });

  /** The panel's own headings are server-rendered, so they are not in the `tt()` sweep above — and
   *  a half-translated strip is the same defect. */
  it('defines the panel\'s server-rendered strings in both languages too', () => {
    const he = translations.he.dashboard as unknown as Record<string, string>;
    const en = translations.en.dashboard as unknown as Record<string, string>;
    for (const key of ['payTransferTitle', 'payTransferSource', 'payChargesTitle', 'payChargesHint']) {
      expect(he[key], `he.dashboard.${key}`).toBeTruthy();
      expect(en[key], `en.dashboard.${key}`).toBeTruthy();
    }
  });
});
