import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sellerPrintsLabels, availableDeliveryMethods, shippingPrice } from '../src/lib/shipping.js';
import { storeSettingsRev, mergeByFieldRev, STORE_REV_FIELDS } from '../src/lib/record-rev.js';

/**
 * The seller's label-printing choice (owner, 2026-08-25):
 *   "אני רוצה לאפשר מצב שבו המוכר גם לא צריך להדפיס מדבקות, אבל כן לאפשר את זה אם הוא בוחר בכך."
 *
 * Two properties carry the whole rule, and both are easy to break by accident later:
 *   1. NOT printing is the DEFAULT — a seller who never opened the settings screen is not
 *      quietly signed up to owning a printer.
 *   2. The choice is cosmetic to the shipment. It decides whether a print action is shown and
 *      nothing else; it must never reach delivery methods, prices, or whether a shipment exists.
 */
describe('sellerPrintsLabels — the default is the decision', () => {
  it('is false for a seller who never touched the setting', () => {
    expect(sellerPrintsLabels({})).toBe(false);
    expect(sellerPrintsLabels({ shipping: {} })).toBe(false);
    expect(sellerPrintsLabels(null)).toBe(false);
    expect(sellerPrintsLabels(undefined)).toBe(false);
  });

  it('is true only for an explicit opt-in', () => {
    expect(sellerPrintsLabels({ shipping: { printsLabels: true } })).toBe(true);
  });

  it('treats a truthy non-boolean as NOT opted in', () => {
    // The value arrives from a JSON column, so a legacy row could hold anything. Anything that
    // is not literally `true` leaves the seller on the path that asks nothing of him — the safe
    // direction, since the cost of guessing wrong is a seller expected to own a printer.
    const loose = { shipping: { printsLabels: 'on' as unknown as boolean } };
    expect(sellerPrintsLabels(loose)).toBe(false);
  });
});

describe('the choice does not leak into the shipment', () => {
  it('does not change which delivery methods a buyer is offered', () => {
    // Buyers must not see a different checkout because of how the seller labels a parcel.
    expect(availableDeliveryMethods(false)).toEqual(['courier', 'pickup_point']);
    expect(availableDeliveryMethods(true)).toEqual(['pickup', 'courier', 'pickup_point']);
  });

  it('does not change any price', () => {
    expect(shippingPrice('courier')).toBe(30);
    expect(shippingPrice('pickup_point')).toBe(20);
    expect(shippingPrice('pickup')).toBe(0);
  });
});

describe('the shipping settings column is written whole', () => {
  /**
   * `/api/store` rebuilds `shipping` from scratch on every save, so a field missing from that
   * object is a field ERASED the next time the seller edits anything else on the page — his
   * opening hours would silently reset his print preference. There is no migration to catch
   * this and no type error either, because the object is assembled inline. So the guard is a
   * read of the source: every key of StoreShipping must appear on both write paths.
   */
  const api = readFileSync(new URL('../src/pages/api/store.ts', import.meta.url), 'utf8');
  const model = readFileSync(new URL('../src/lib/stores.ts', import.meta.url), 'utf8');

  const shippingKeys = (() => {
    const block = model.slice(model.indexOf('export interface StoreShipping'));
    const body = block.slice(block.indexOf('{') + 1, block.indexOf('}'));
    return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
  })();

  it('found the StoreShipping fields to check', () => {
    expect(shippingKeys).toContain('selfPickup');
    expect(shippingKeys).toContain('printsLabels');
  });

  it.each(shippingKeys)('/api/store reads and persists %s', (key) => {
    // Read from the submitted form on create...
    expect(api).toContain(`form.get('${key}')`);
    // ...and named again in the object handed to updateStore, which replaces the column.
    const updateCall = api.slice(api.indexOf('const saved = await updateStore('));
    expect(updateCall.slice(0, updateCall.indexOf('});'))).toContain(key);
  });
});

describe('the seller settings screen offers the choice', () => {
  const dashboard = readFileSync(new URL('../src/pages/seller/dashboard.astro', import.meta.url), 'utf8');

  it('renders a checkbox whose name matches what the endpoint reads', () => {
    expect(dashboard).toContain('name="printsLabels"');
  });

  it('reads its checked state through the rule, not off the raw field', () => {
    // `checked={!!store.shipping?.printsLabels}` would work today and would drift the moment the
    // default changes. One accessor, one default.
    expect(dashboard).toContain('sellerPrintsLabels(store)');
  });

  it('has copy for the label and its hint in both languages', () => {
    const t = readFileSync(new URL('../src/i18n/translations.ts', import.meta.url), 'utf8');
    expect([...t.matchAll(/^\s*printsLabels:/gm)].length).toBe(2);
    expect([...t.matchAll(/^\s*printsLabelsHint:/gm)].length).toBe(2);
  });
});

describe('two tabs, two different shipping switches — the merge must not call it a conflict', () => {
  /**
   * `shipping` is ONE JSON column holding several independent switches. While it held a single
   * key, listing it whole in STORE_REV_FIELDS was indistinguishable from listing that key. Adding
   * a second one made the difference visible and wrong: a tab that changed only self-pickup and a
   * tab that changed only label-printing both reported "shipping changed, to a different value" —
   * the exact interruption mergeByFieldRev exists to prevent, and with `force`, the silent revert
   * underneath it. The first case was run against the whole-object field list and fails there.
   */
  const stored0 = {
    name: 'חנות', tagline: '', description: '', categories: [],
    bannerImage: undefined, profileImage: undefined,
    address: '', addressVisible: false, hours: {}, hoursVisible: false,
    shipping: { selfPickup: false, printsLabels: false },
    headerLogo: undefined, headerStyle: 'name',
  };

  it('lets each tab keep its own switch, with no conflict', () => {
    const baseline = storeSettingsRev(stored0);

    // Tab A ticks "I print labels" and saves first.
    const afterA = mergeByFieldRev({
      fields: STORE_REV_FIELDS,
      submitted: { ...stored0, shipping: { selfPickup: false, printsLabels: true } },
      stored: stored0,
      baseline,
    });
    expect(afterA.conflicts).toEqual([]);
    const storedAfterA = { ...stored0, ...afterA.merged };

    // Tab B was rendered before that, and ticks self-pickup only.
    const afterB = mergeByFieldRev({
      fields: STORE_REV_FIELDS,
      submitted: { ...stored0, shipping: { selfPickup: true, printsLabels: false } },
      stored: storedAfterA,
      baseline,
    });

    expect(afterB.conflicts).toEqual([]);
    expect(afterB.merged.shipping).toEqual({ selfPickup: true, printsLabels: true });
  });

  it('a switch this tab did not touch keeps the other tab value', () => {
    const submitted = { ...stored0, shipping: { selfPickup: false, printsLabels: true } };
    const outcome = mergeByFieldRev({
      fields: STORE_REV_FIELDS,
      submitted,
      stored: { ...stored0, shipping: { selfPickup: false, printsLabels: false } },
      baseline: storeSettingsRev(submitted),
    });
    expect(outcome.conflicts).toEqual([]);
    expect((outcome.merged.shipping as { printsLabels?: boolean }).printsLabels).toBe(false);
  });

  it('a stale baseline of the wrong length still falls back to the submission', () => {
    // Documented behaviour of extending the field list: one save per form open across a deploy.
    const outcome = mergeByFieldRev({
      fields: STORE_REV_FIELDS,
      submitted: { ...stored0, shipping: { selfPickup: true, printsLabels: true } },
      stored: stored0,
      baseline: 'a.b.c',
    });
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.shipping).toEqual({ selfPickup: true, printsLabels: true });
  });

  it('every dotted path in STORE_REV_FIELDS names a real StoreShipping key', () => {
    // Both directions. A path pointing at nothing merges garbage; a key with no path is a key the
    // settings save never writes at all, which is the erase trap one level down.
    const model = readFileSync(new URL('../src/lib/stores.ts', import.meta.url), 'utf8');
    const block = model.slice(model.indexOf('export interface StoreShipping'));
    const body = block.slice(block.indexOf('{') + 1, block.indexOf('}'));
    const keys = [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
    const listed = STORE_REV_FIELDS
      .filter((f) => f.startsWith('shipping.'))
      .map((f) => f.slice('shipping.'.length));
    expect([...listed].sort()).toEqual([...keys].sort());
  });
});
