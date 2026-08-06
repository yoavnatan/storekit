/**
 * Google Merchant Center adapter — Content API v2.1, read-only.
 *
 * Two endpoints, because Google reports two different kinds of failure and only one of them is
 * visible per item:
 *
 * - `datafeedstatuses` — did the FEED get in at all. This is the endpoint that catches
 *   memory `project_feed_silent_rejection_class` hole #1: one XML-illegal character makes the whole
 *   document unparseable, so every store's products drop at once. Item statuses cannot show that —
 *   with nothing ingested there are no items to have a status.
 * - `productstatuses` — what happened to each row that did get in.
 *
 * **`productId` here is not our id.** Google answers with its own REST id,
 * `channel:contentLanguage:targetCountry:offerId` (e.g. `online:he:IL:<uuid>`), and the offer id we
 * published is the last segment. Reading the whole string as our id would match no product on the
 * platform and quietly report every rejection as "unrecognised" — the same shape of join failure
 * that made the feed and the browser events disagree for four months (`ad-item-id.ts`). It is
 * split here, at the boundary, so nothing downstream has to know Google's format.
 */
import { getGoogleAccessToken, parseServiceAccountKey } from './google-auth.js';
import { outboundFetch } from './outbound-fetch.js';
import { MAX_STATUS_PAGES, clampIssue, clampIssueCode, type MerchantItemStatus, type MerchantStatusProvider, type MerchantStatusReport } from './merchant-status.js';

const API = 'https://shoppingcontent.googleapis.com/content/v2.1';
const PAGE_SIZE = 250;

interface GoogleItemIssue {
  code?: string;
  servability?: string;
  description?: string;
  detail?: string;
  attributeName?: string;
}

interface GoogleProductStatus {
  productId?: string;
  itemLevelIssues?: GoogleItemIssue[];
  destinationStatuses?: { disapprovedCountries?: string[] }[];
}

interface GoogleStatusPage {
  kind?: string;
  resources?: GoogleProductStatus[];
  nextPageToken?: string;
}

interface GoogleFeedStatus {
  processingStatus?: string;
  errors?: { message?: string; count?: number }[];
}

interface GoogleFeedPage {
  kind?: string;
  resources?: GoogleFeedStatus[];
}

/**
 * The offer id we published, out of Google's composite REST id.
 *
 * Split from the RIGHT: the offer id is the last of four colon-separated segments, and our ids can
 * themselves contain a colon only if a variant option value does — which is allowed, since
 * `ad-item-id.ts` deliberately preserves Unicode option values verbatim. Splitting from the left
 * would truncate exactly those. A string with no colon at all is passed through unchanged rather
 * than rejected: it costs nothing and it is what a future API version returning a bare offer id
 * would send.
 */
export function offerIdFromGoogleProductId(productId: string): string {
  const parts = productId.split(':');
  return parts.length > 3 ? parts.slice(3).join(':') : productId;
}

/** Not serving, by either of the two signals Google gives. `servability: 'disapproved'` is the
 *  explicit one; a non-empty `disapprovedCountries` is the same verdict expressed per destination,
 *  and an item can carry the second without the first. `'demoted'` is deliberately NOT counted —
 *  the row still serves, just lower, and paging a seller about a ranking nudge is how a channel
 *  gets muted. */
function isDisapproved(status: GoogleProductStatus): boolean {
  if (status.itemLevelIssues?.some((issue) => issue.servability === 'disapproved')) return true;
  return status.destinationStatuses?.some((d) => (d.disapprovedCountries?.length ?? 0) > 0) ?? false;
}

/** The issue worth telling the seller about: the one that actually stopped the row from serving. */
function primaryIssue(status: GoogleProductStatus): GoogleItemIssue | undefined {
  return status.itemLevelIssues?.find((issue) => issue.servability === 'disapproved')
    ?? status.itemLevelIssues?.[0];
}

export function createGoogleMerchantProvider(merchantId: string, serviceAccountJson: string): MerchantStatusProvider {
  return {
    network: 'google',

    async fetchStatuses(): Promise<MerchantStatusReport | null> {
      const key = parseServiceAccountKey(serviceAccountJson);
      if (!key) return null;
      const token = await getGoogleAccessToken(key);
      if (!token) return null;
      const headers = { Authorization: `Bearer ${token}` };

      // Feed level first, and it ENDS the pass. If the document never made it in, the item statuses
      // describe the LAST good ingest — a healthy-looking catalogue while nothing is being updated —
      // so walking twenty pages of them would cost real API calls to produce a reading that must be
      // discarded anyway. The caller reports the feed failure and never looks at items.
      const feedError = await fetchFeedError(merchantId, headers);
      if (feedError === null) return null;
      if (feedError) return { network: 'google', items: [], feedError };

      const items: MerchantItemStatus[] = [];
      let pageToken: string | undefined;
      let truncated = false;

      for (let page = 0; page < MAX_STATUS_PAGES; page++) {
        const url = new URL(`${API}/${encodeURIComponent(merchantId)}/productstatuses`);
        url.searchParams.set('maxResults', String(PAGE_SIZE));
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        let body: GoogleStatusPage;
        try {
          const res = await outboundFetch(url, { headers });
          if (!res.ok) return null;
          body = await res.json() as GoogleStatusPage;
        } catch { return null; }

        // Shape check — see the contract's note. A 200 we cannot recognise is an unreachable answer,
        // never an empty catalogue: the difference between "Google says nothing is wrong" and "we
        // are not reading Google" is the entire value of this job.
        if (typeof body.kind !== 'string' && !Array.isArray(body.resources)) return null;

        for (const resource of body.resources ?? []) {
          if (!resource.productId) continue;
          const issue = primaryIssue(resource);
          const code = clampIssueCode(issue?.code);
          const text = clampIssue(issue?.description ?? issue?.detail);
          items.push({
            itemId: offerIdFromGoogleProductId(resource.productId),
            approved: !isDisapproved(resource),
            ...(code ? { issueCode: code } : {}),
            ...(text ? { issue: text } : {}),
          });
        }

        pageToken = body.nextPageToken;
        if (!pageToken) break;
        // Still more pages when the loop is about to end ⇒ what we have is a prefix, and the caller
        // has to say so rather than report a clean bill of health for products it never read.
        if (page === MAX_STATUS_PAGES - 1) truncated = true;
      }

      return { network: 'google', items, ...(truncated ? { truncated } : {}) };
    },
  };
}

/**
 * The feed's own processing status: a message when the last ingest failed, `''` when it did not,
 * and `null` when we could not tell — which propagates as "no answer" for the whole provider.
 */
async function fetchFeedError(merchantId: string, headers: Record<string, string>): Promise<string | null> {
  let body: GoogleFeedPage;
  try {
    const res = await outboundFetch(`${API}/${encodeURIComponent(merchantId)}/datafeedstatuses`, { headers });
    if (!res.ok) return null;
    body = await res.json() as GoogleFeedPage;
  } catch { return null; }

  if (typeof body.kind !== 'string' && !Array.isArray(body.resources)) return null;

  const failed = (body.resources ?? []).filter((feed) => feed.processingStatus === 'failure');
  if (!failed.length) return '';

  // The first error message carries the reason; the count is what says it is the document and not
  // one row. Both go in the alert, because "1 error, 40,000 items affected" is the sentence that
  // tells the reader this is not a seller's problem.
  const first = failed[0]?.errors?.[0];
  const affected = failed.reduce((sum, feed) => sum + (feed.errors?.[0]?.count ?? 0), 0);
  return `${first?.message ?? 'feed processing failed'}${affected ? ` (${affected} rows affected)` : ''}`;
}
