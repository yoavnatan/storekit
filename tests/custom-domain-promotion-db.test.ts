/**
 * What a PROMOTION is allowed to do — against a real Postgres (area audit row 5, 2026-08-16).
 *
 * Two consequences follow from a hostname being yours: the store that used to be served from it
 * stops 301-ing away, and no other store may serve it. Both used to be settled when a seller TYPED
 * the hostname into their dashboard, which is not evidence of anything — the field takes any string
 * and every logged-in seller has one. So the first was a cross-store delete anyone could perform
 * (kill a competitor's old-link redirects, permanently, silently) and the second was a free squat
 * (hold any hostname pending forever and its real owner is answered `domain-taken` for good).
 *
 * `'active'` is the provider confirming DNS resolves to us and the certificate issued, which only
 * whoever controls the domain can arrange. So this file pins that both consequences land there and
 * nowhere earlier, and that a promotion which WOULD collide with a live domain does not happen.
 *
 * The stub provider answers 'active' under CUSTOM_DOMAIN_DEV_AUTOVERIFY — stubbed before any import
 * of the module under test, because `getCustomDomainProvider` caches its choice on first call.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import crypto from 'node:crypto';

beforeAll(() => { vi.stubEnv('CUSTOM_DOMAIN_DEV_AUTOVERIFY', '1'); });

import { query } from '../src/lib/db.js';
import {
  createStore,
  getStoreById,
  getStoreByPreviousCustomDomain,
  rememberPreviousCustomDomain,
  updateStore,
} from '../src/lib/stores.js';
import { reverifyCustomDomain } from '../src/lib/custom-domain-verify.js';

const ADDED_AT = '2026-02-01T00:00:00.000Z';

async function freshSeller(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [id, `${id}@example.test`],
  );
  return id;
}

let n = 0;
const freshHost = () => `promo-${Date.now().toString(36)}-${n++}.example.test`;

describe('a custom domain takes effect only when it verifies', () => {
  it('claims the hostname off its previous owner on the pending→active transition', async () => {
    const seller = await freshSeller();
    const mover = await createStore(seller, { name: 'M', slug: `m-${n++}-${Date.now().toString(36)}` });
    const hostname = freshHost();

    // The mover used this hostname and moved off it — its links 301 to wherever the store is now.
    await rememberPreviousCustomDomain(mover.id, hostname);
    expect((await getStoreByPreviousCustomDomain(hostname))?.id).toBe(mover.id);

    // Somebody else now points a record at the same hostname. Merely asserting it changes nothing:
    // this is the whole finding — it used to delete the row above on the spot.
    const claimer = await createStore(seller, { name: 'C', slug: `c-${n++}-${Date.now().toString(36)}` });
    await updateStore(claimer.id, { customDomain: { hostname, status: 'pending', addedAt: ADDED_AT } });
    expect((await getStoreByPreviousCustomDomain(hostname))?.id).toBe(mover.id);

    // Verification is what settles it.
    const result = await reverifyCustomDomain((await getStoreById(claimer.id))!);
    expect(result.stored).toBe('active');
    expect(await getStoreByPreviousCustomDomain(hostname)).toBeNull();
  });

  /**
   * Two stores can never HOLD one hostname — `stores.custom_domain_hostname` is `citext UNIQUE`
   * (0001), so the registration 409 is a readable message in front of a constraint rather than the
   * thing enforcing it. Pinned because the audit briefly "fixed" `isCustomDomainTaken` to ignore
   * pending claims, which does not loosen anything: it just turns that 409 into a duplicate-key 500.
   */
  it('cannot store one hostname on two stores at all, pending or not', async () => {
    const seller = await freshSeller();
    const hostname = freshHost();
    const live = await createStore(seller, { name: 'L', slug: `l-${n++}-${Date.now().toString(36)}` });
    await updateStore(live.id, { customDomain: { hostname, status: 'active', addedAt: ADDED_AT } });

    const rival = await createStore(seller, { name: 'R', slug: `r-${n++}-${Date.now().toString(36)}` });
    await expect(
      updateStore(rival.id, { customDomain: { hostname, status: 'pending', addedAt: ADDED_AT } }),
    ).rejects.toThrow(/unique|duplicate/i);
    expect((await getStoreById(live.id))!.customDomain).toMatchObject({ hostname, status: 'active' });
  });

  it('leaves the previous owner alone when a check comes back inconclusive', async () => {
    const seller = await freshSeller();
    const mover = await createStore(seller, { name: 'M', slug: `m2-${n++}-${Date.now().toString(36)}` });
    const hostname = freshHost();
    await rememberPreviousCustomDomain(mover.id, hostname);

    // A store with no domain at all: `reverifyCustomDomain` returns before asking anything, which is
    // the shape an 'unknown' answer also takes — nothing is written, so nothing is claimed either.
    const claimer = await createStore(seller, { name: 'C', slug: `c2-${n++}-${Date.now().toString(36)}` });
    const result = await reverifyCustomDomain((await getStoreById(claimer.id))!);
    expect(result.changed).toBe(false);
    expect((await getStoreByPreviousCustomDomain(hostname))?.id).toBe(mover.id);
  });
});
