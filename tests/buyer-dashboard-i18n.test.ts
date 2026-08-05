/**
 * The buyer's personal area renders in the buyer's language — all of it.
 *
 * Same class as `tests/orders-i18n.test.ts` guards on the seller side, on the
 * other page that has it: the order card has TWO renderers here — the SSR block
 * in `buyer/dashboard.astro` and the `buildOrderCardHTML` rebuild in its own
 * `<script>` (search, pagination and the active/history switch all go through
 * the second one). The script cannot import the dictionary, so it reads strings
 * off a `#buyer-i18n` element's dataset with an English literal as the fallback.
 *
 * That fallback is what makes the failure silent. A key the element does not
 * publish is not a type error and not an empty string — it is the English
 * default, quietly, inside an otherwise Hebrew page, and only on the AJAX path
 * so the first paint looks right. Three keys were added to this bridge on
 * 2026-08-05 when the card became one-per-purchase; this is what stops the
 * fourth from arriving half-wired.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { translations } from '../src/i18n/translations.js';

const SOURCE = readFileSync(join(process.cwd(), 'src/pages/buyer/dashboard.astro'), 'utf8');

/** `shipCancelled` → `data-ship-cancelled`, the way the DOM maps the two. */
const toDataAttr = (key: string) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** Every `_i18nEl.dataset.X` the client script reads. */
const consumed = [...new Set([...SOURCE.matchAll(/_i18nEl\.dataset\.(\w+)/g)].map((m) => m[1]!))];

describe('the buyer dashboard i18n bridge', () => {
  it('is actually found, so a rename cannot turn this into a no-op', () => {
    expect(consumed.length).toBeGreaterThan(20);
  });

  it('publishes every key the client renderer reads', () => {
    // The element is written by hand, one attribute per line, so an added
    // `I.foo` with no matching `data-foo` is the easy half of the mistake.
    const missing = consumed.filter((key) => !SOURCE.includes(`${toDataAttr(key)}=`));
    expect(missing, 'add these to the #buyer-i18n element, or the AJAX path renders English').toEqual([]);
  });

  it('only publishes strings both dictionaries define', () => {
    const he = translations.he.buyerDashboard as unknown as Record<string, string>;
    const en = translations.en.buyerDashboard as unknown as Record<string, string>;
    const keys = [...new Set([...SOURCE.matchAll(/\{t\.buyerDashboard\.(\w+)\}/g)].map((m) => m[1]!))];
    expect(keys.length).toBeGreaterThan(20);
    expect(keys.filter((k) => !he[k] || !en[k])).toEqual([]);
  });

  it('labels every shipping status a real order can carry, in both renderers', () => {
    // `cancelled` was the missing one, in BOTH maps, so a cancelled order printed
    // the raw English enum value to the buyer. The label maps are keyed by the
    // status itself, so a new status is silently unlabelled until it is added —
    // and the Order type is the only place that knows one exists.
    const orders = readFileSync(join(process.cwd(), 'src/lib/orders.ts'), 'utf8');
    const declared = [.../^\s*shippingStatus:\s*(.+);\s*$/m.exec(orders)![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);

    for (const map of ['shipLabel', 'shipLabelClient']) {
      const body = new RegExp(`${map}[^=]*=\\s*\\{([^}]*)\\}`).exec(SOURCE)?.[1] ?? '';
      const missing = declared.filter((s) => !new RegExp(`\\b${s}:`).test(body));
      expect(missing, `${map} has no label for these statuses`).toEqual([]);
    }
  });
});
