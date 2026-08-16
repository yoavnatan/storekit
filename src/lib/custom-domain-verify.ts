// Re-verifying a seller's custom domain — the ONE step, called from both places that verify.
//
// Two callers ask the same question: the seller pressing "check" in the dashboard, and the periodic
// job (jobs/registry.ts → custom-domain-check). They must reach the same conclusion and leave the
// same record behind, so the rule lives here rather than in each of them — the same reason
// campaign-sweep calls the page's own function instead of re-deriving it.
//
// **Why the job exists at all.** `custom_domain_status` decides real behaviour: an 'active' domain
// is the store's SEO canonical, it is what every platform surface links to, and every hit on the
// platform path 301s to it. Until this file, that status was only ever written when a human pressed
// a button — so a seller who removed the CNAME, let the domain expire, or moved hosts took their own
// store offline permanently and silently, and the store's ads kept sending paid clicks into it.
//
// The counterpart matters just as much: a seller who pointed their DNS and closed the tab was never
// told it worked. Verification usually completes minutes to hours later, and nothing was watching.

import { getStoreById, updateStore, claimCustomDomainHostname, type Store } from './stores.js';
import { getCustomDomainProvider, type CustomDomainCheck } from './custom-domain.js';
import { createNotification } from './notifications.js';
import { logError } from './error-log.js';

export interface DomainCheckResult {
  /** What the provider answered. 'unknown' ⇒ nothing was written; ask again next run. */
  status: CustomDomainCheck;
  /** The status now stored — unchanged from before when `status` was 'unknown'. */
  stored: 'pending' | 'active';
  /** True when this check moved the stored status. */
  changed: boolean;
}

/**
 * Ask the provider whether `store`'s domain still verifies, and record the answer.
 *
 * Writes `checkedAt` on EVERY call, including an inconclusive one: the column's meaning is "when we
 * last asked", and the job orders by it, so a provider that is down for a day must not starve the
 * rotation by leaving its stores permanently first in line.
 *
 * Never throws — the provider swallows its own errors by contract, and a failed notification must
 * not lose the status write that earned it.
 */
export async function reverifyCustomDomain(store: Store): Promise<DomainCheckResult> {
  const cd = store.customDomain;
  if (!cd) return { status: 'unknown', stored: 'pending', changed: false };

  const { status } = await getCustomDomainProvider().checkStatus(cd.hostname);
  const checkedAt = new Date().toISOString();

  // Inconclusive: stamp the attempt, touch nothing else. See custom-domain.ts#CustomDomainCheck for
  // why this branch is the whole reason the type has three members.
  if (status === 'unknown') {
    await updateStore(store.id, { customDomain: { ...cd, checkedAt } });
    return { status, stored: cd.status, changed: false };
  }

  // ── The promotion is where ownership of the hostname is actually established ──
  // Everything before this point is a seller asserting a string: the dashboard field takes anything
  // and every logged-in seller has one. `'active'` is the provider saying the DNS record resolves to
  // us and the certificate issued, which only whoever controls the domain can arrange.
  //
  // So the one consequence that reaches ANOTHER store — the previous owner's 301 memory being
  // deleted — is taken here, and not when the seller typed the hostname in (area audit row 5,
  // 2026-08-16). It used to run at registration, and the store whose row was deleted is not the one
  // performing the action: type a hostname some other store moved off, and every link, bookmark and
  // indexed page it earned there stopped being a 301 and became a 404, permanently, with no error on
  // either side. `stores.custom_domain_hostname` is UNIQUE, so this was reachable only for a
  // hostname no store currently holds — which is exactly the set that `store_previous_domains`
  // exists for.
  //
  // Waiting costs nothing: `getStoreByCustomDomain` matches `'active'` only and the middleware asks
  // it before the previous-owner lookup, so a promoted domain shadows the old row from its first
  // request either way.
  const changed = status !== cd.status;
  await updateStore(store.id, { customDomain: { ...cd, status, checkedAt } });

  // AFTER the promotion is durable, and swallowing its own error, both for the same reason: of the
  // two ways this pair can half-happen, only one is harmful. A claim that lands without the
  // promotion is a store's 301s deleted for a domain that then did not go live — unrecoverable. A
  // promotion whose claim is lost leaves a stale row that is already shadowed by the sentence above,
  // and the next successful check clears it. So the destructive half goes second and may fail.
  if (status === 'active' && cd.status !== 'active') {
    await claimCustomDomainHostname(cd.hostname).catch(() => { /* shadowed anyway; retried next check */ });
  }

  if (changed) await notifySeller(store, status).catch(() => { /* the status write stands */ });
  return { status, stored: status, changed };
}

/**
 * Tell the seller, because both directions are news they cannot get anywhere else.
 *
 * A demotion moves their storefront back to the platform URL — an operational fact about their own
 * business that they would otherwise discover from a customer. A promotion is the confirmation they
 * stopped waiting for. The dashboard's settings panel already renders the state, so the notification
 * only has to get them there.
 */
async function notifySeller(store: Store, status: 'pending' | 'active'): Promise<void> {
  const hostname = store.customDomain!.hostname;
  await createNotification({
    userId: store.sellerId,
    role: 'seller',
    type: 'domain_status',
    title: status === 'active' ? 'הדומיין שלך פעיל' : 'הדומיין שלך הפסיק לעבוד',
    body: status === 'active'
      ? `${hostname} מאומת והחנות שלך מוגשת ממנו.`
      : `${hostname} כבר לא מאומת, והחנות חזרה לכתובת שלנו. בדוק את רשומת ה-CNAME אצל רשם הדומיין.`,
    storeSlug: store.slug,
    storeName: store.name,
  });
}

/**
 * The re-check pass over a batch of stores, with the blast radius bounded.
 *
 * **The cap is the point.** One demotion is a seller who changed their DNS. Many at once is not
 * many sellers — it is our own credentials, our own zone, or Cloudflare having a bad day, and
 * acting on it would take every custom-domain store off its own domain simultaneously. Answering an
 * infrastructure failure by rewriting every seller's record is the kind of correct-looking loop that
 * only ever runs once. So a run that would demote more than {@link demoteCeiling} stores demotes
 * none of them and says so — promotions are unaffected, since a false promotion is not destructive
 * and a mass promotion is just a backlog clearing.
 *
 * The scenario this is sized for is specific and not hypothetical: an unreachable provider now
 * answers `'unknown'` and cannot demote anyone, but a provider we reach with the WRONG ZONE ID
 * answers perfectly well — with an empty result for every hostname, which reads as a genuine
 * "not verified" for the entire platform at once.
 *
 * Returns the one line the job records.
 */
export const DEMOTE_LIMIT = 3;

/** How many demotions one pass may believe: a floor of {@link DEMOTE_LIMIT} while the platform is
 *  small, and a quarter of the domains checked once it is not. A fixed 3 would have become the
 *  wrong shape in the other direction at scale — with 200 live domains, three sellers changing
 *  their DNS in one hour is ordinary Tuesday traffic, and holding it would mean the demotion never
 *  runs again. It is a ratio because the signal is "a share of the platform at once", not a count. */
export function demoteCeiling(checked: number): number {
  return Math.max(DEMOTE_LIMIT, Math.floor(checked / 4));
}

export async function reverifyCustomDomains(stores: readonly Store[]): Promise<string> {
  const active = stores.filter((s) => s.customDomain?.status === 'active');
  const rest = stores.filter((s) => s.customDomain?.status !== 'active');

  // Look before writing: ask about every currently-active domain first, decide whether the answer is
  // believable, and only then write. A loop that verified and demoted in one pass could not know
  // what the tenth store was going to say by the time it had already acted on the first.
  const verdicts = await Promise.all(active.map(async (store) => {
    const { status } = await getCustomDomainProvider().checkStatus(store.customDomain!.hostname);
    return { store, status };
  }));
  const failing = verdicts.filter((v) => v.status === 'pending');
  const ceiling = demoteCeiling(verdicts.length);
  const believable = failing.length <= ceiling;

  const checkedAt = new Date().toISOString();
  let demoted = 0, promoted = 0, unknown = 0;

  for (const { store, status } of verdicts) {
    const cd = store.customDomain!;
    if (status === 'unknown') { unknown++; await stamp(store, checkedAt); continue; }
    if (status === 'pending' && !believable) { await stamp(store, checkedAt); continue; }
    if (status === 'pending') {
      demoted++;
      await updateStore(store.id, { customDomain: { ...cd, status, checkedAt } });
      await notifySeller(store, status).catch(() => { /* the status write stands */ });
    } else {
      await stamp(store, checkedAt);
    }
  }

  // Pending domains go through the single-store path: a promotion has no blast radius to bound, and
  // it re-reads the store so a seller who removed their domain mid-run is not resurrected.
  for (const store of rest) {
    const fresh = await getStoreById(store.id);
    if (!fresh?.customDomain) continue;
    const result = await reverifyCustomDomain(fresh);
    if (result.status === 'unknown') unknown++;
    else if (result.changed) promoted++;
  }

  if (!believable) {
    // Held demotions are the one outcome nobody sees: every store keeps working, so there is no
    // symptom — while the most likely cause (our token, our zone) is ours to fix and gets worse the
    // longer it runs. It goes in the error log, where §2 escalation reads it.
    await logError({
      source: 'server',
      route: 'job:custom-domain-check',
      message: `${failing.length} of ${verdicts.length} custom domains reported unverified in one pass (ceiling ${ceiling}) — demotions held`,
      resolutionHint: 'Check CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID and the Cloudflare status page. Sellers are unaffected while this holds; verify before assuming they unpointed their DNS.',
    }).catch(() => { /* the job's own line still reports it */ });
  }

  const held = believable ? '' : ` · HELD ${failing.length} demotions (over ${ceiling} — treated as our failure, not theirs)`;
  return `checked ${stores.length} · promoted ${promoted} · demoted ${demoted} · unknown ${unknown}${held}`;
}

/** Record that we asked, without changing the verdict. */
async function stamp(store: Store, checkedAt: string): Promise<void> {
  await updateStore(store.id, { customDomain: { ...store.customDomain!, checkedAt } });
}
