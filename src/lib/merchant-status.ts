/**
 * Asking Google and Meta what they actually did with our feed — the contract, the stub, and the
 * provider resolver. No provider specifics here (see the two sibling files), the same way
 * `custom-domain.ts` holds the contract and `custom-domain-cloudflare.ts` holds Cloudflare.
 *
 * **Why this exists, and why it is a job and not a checklist line.** Merchant Center and Meta
 * Catalog reject a row **without telling anyone** (memory `project_feed_silent_rejection_class`):
 * the product sits on the storefront looking perfectly fine, and no ad ever runs behind it. Until
 * this module the plan was that the owner would read the approval report by hand on connection day —
 * a one-time reading of a state that changes every time any seller edits any product. A seller
 * pastes a description out of Word next month, the row dies, and nothing on the platform knows.
 * The owner's rule, 2026-08-06: *"שום דבר לא אמור להיות ידני."* Opening the account is a one-time
 * human act; watching it is code.
 *
 * **The one rule every provider must obey: never answer "fine" when you mean "I do not know".**
 * `fetchStatuses` returns `null` for *any* failure to reach an answer — network error, HTTP error,
 * an auth token we could not mint, **and a 200 whose body is not the shape we expected**. That last
 * one is the load-bearing case and it is not hypothetical: these two APIs are the part of this
 * feature nobody can test against reality until the accounts exist, so a field name being wrong is a
 * live possibility. If a wrong field name parsed as "zero rejected items", the monitor would report
 * a clean bill of health forever and be worse than not existing — the failure mode it was built to
 * end, rebuilt one layer up. Parsing nothing recognisable is therefore an unreachable answer, and an
 * unreachable answer is loud (`merchant-status-check.ts` escalates a provider that stays silent).
 * This is the same discipline as `CustomDomainCheck['unknown']`, for the same reason.
 */
import { serverEnv } from './runtime-env.js';
import { createGoogleMerchantProvider } from './merchant-status-google.js';
import { createMetaCatalogProvider } from './merchant-status-meta.js';

/** The two ad networks the platform publishes one feed to. Both read the SAME feed, and both judge
 *  it by their own rules — a row Google approves can be rejected by Meta (GO_LIVE §2.5 layer 1),
 *  which is exactly why the status has to be asked per network rather than inferred once. */
export type MerchantNetwork = 'google' | 'meta';

export const NETWORK_LABEL: Record<MerchantNetwork, string> = {
  google: 'Google Merchant Center',
  meta: 'Meta Catalog',
};

/** One row's verdict, in our vocabulary rather than the network's. */
export interface MerchantItemStatus {
  /** The `id` we published for this row — an ad item id (`ad-item-id.ts`), which is how it maps back
   *  to a product and therefore to a seller. */
  itemId: string;
  /** Serving somewhere it was meant to serve. `false` covers both "disapproved" and "pending
   *  review for so long it is not serving"; the distinction belongs to the network, the consequence
   *  to the seller is identical. */
  approved: boolean;
  /** The network's own machine code, e.g. `image_link_broken`. Used for grouping, never shown raw. */
  issueCode?: string;
  /** One line the seller can act on, in the network's words. */
  issue?: string;
}

export interface MerchantStatusReport {
  network: MerchantNetwork;
  /** Every row the network currently holds for us. An EMPTY array is a real answer and a bad one —
   *  the feed reached them and produced no items at all — not the same as `null`. */
  items: MerchantItemStatus[];
  /** The page cap was reached, so `items` is a PREFIX of the catalogue and not the catalogue.
   *  Carried rather than left implicit because a monitor that quietly covers the first N products
   *  reports "nothing wrong" about the ones it never read — the silent-coverage-gap version of the
   *  silent rejection it exists to catch. The caller announces it. */
  truncated?: boolean;
  /** Set when the network rejected the feed as a document rather than row by row (it could not fetch
   *  the URL, the XML would not parse, the account is suspended). This is the whole platform's ads
   *  down at once, so it is reported on its own rather than as N item failures. */
  feedError?: string;
}

export interface MerchantStatusProvider {
  network: MerchantNetwork;
  /**
   * The current status of every row, or `null` when no answer could be reached.
   *
   * Must never throw: the caller is a scheduled job that has to go on to the other network.
   */
  fetchStatuses(): Promise<MerchantStatusReport | null>;
}

/**
 * The providers that are actually configured, in a fixed order.
 *
 * Empty until the accounts exist, and that is the whole dev/CI story: no credentials, no provider,
 * the job reports "not configured" and touches nothing. There is deliberately no stub that invents
 * statuses — `custom-domain.ts` has one because a seller flow must stay walkable locally, whereas
 * nothing in the product depends on this reply. A stub here could only teach us that our own fake
 * data parses.
 *
 * Not cached, unlike `getCustomDomainProvider`: this is consulted once an hour by one job, so a
 * cache would buy nothing and would mean a rotated token needs a restart to take effect.
 */
export function getMerchantStatusProviders(): MerchantStatusProvider[] {
  const providers: MerchantStatusProvider[] = [];

  const merchantId = serverEnv('GOOGLE_MERCHANT_ID');
  const serviceAccount = serverEnv('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (merchantId && serviceAccount) providers.push(createGoogleMerchantProvider(merchantId, serviceAccount));

  const catalogId = serverEnv('META_CATALOG_ID');
  const metaToken = serverEnv('META_ACCESS_TOKEN');
  if (catalogId && metaToken) providers.push(createMetaCatalogProvider(catalogId, metaToken));

  return providers;
}

/**
 * How many pages of statuses one run will walk, per network.
 *
 * A bound rather than "read everything": these are paged APIs over the whole catalogue, and a job
 * that walks 400 pages holds its lease, its memory and someone's rate limit for as long as the
 * catalogue is big. The cap is announced by the caller rather than applied quietly
 * (`registry.ts`'s own rule about capped batches), and it is generous — at the page sizes both APIs
 * serve it covers a catalogue far larger than anything that will exist before this is re-tuned
 * against real numbers.
 */
export const MAX_STATUS_PAGES = 20;

/**
 * Caps on the free text an ad network sends back, applied at the boundary by both adapters.
 *
 * `issue` reaches a seller's notification body and `issueCode` becomes part of a `related_id`, and
 * neither of those columns clamps anything — `error-log.ts` caps its own message for exactly this
 * reason, and `product-feed.ts` caps every attribute it emits. This is the same rule on the way IN.
 * The text is a third party's, so its length is not ours to assume: nothing in either API's contract
 * promises a short string, and a reply is not less trustworthy for coming from Google.
 *
 * One definition rather than one per adapter — a rule that appears in two modules is the next bug.
 */
const ISSUE_MAX = 300;
const ISSUE_CODE_MAX = 80;

export function clampIssue(text: string | undefined): string | undefined {
  return text ? text.slice(0, ISSUE_MAX) : undefined;
}

export function clampIssueCode(code: string | undefined): string | undefined {
  return code ? code.slice(0, ISSUE_CODE_MAX) : undefined;
}
