/**
 * Meta Catalog adapter — Graph API, read-only.
 *
 * Meta ingests the SAME feed as Google and judges it by its own rules, which is the whole reason
 * GO_LIVE §2.5 layer 1 submits it twice: a row Google approves can be rejected here. The one
 * concrete divergence already known is `availability` (`in_stock` with an underscore for Google,
 * documented as `in stock` with a space by Meta), and it is an assumption nobody has been able to
 * test — this adapter is what turns that assumption into an answer on the first real ingest.
 *
 * **No separate feed-level call, deliberately.** Google gets one because `datafeedstatuses` is a
 * documented endpoint with a documented shape. Meta's equivalent lives behind fields on
 * `product_feeds` that this module cannot verify against a live account, and a guess there would
 * either raise a permanent false alarm or invent a silence. A total ingest failure is already
 * visible without it: the catalogue comes back empty, and an empty answer is treated as a failure
 * by `merchant-status-check.ts` rather than as good news. That covers the case at the cost of a
 * less specific message, which is the right trade for code that cannot be tested yet.
 *
 * **The field names below are the part of this feature that a live account may still correct.** If
 * they are wrong, Graph answers 4xx to the `fields` request and this returns null — the loud
 * failure, not the silent one. That is by design (see `merchant-status.ts`): the one outcome this
 * module must never produce is a clean bill of health it did not actually read.
 */
import { outboundFetch } from './outbound-fetch.js';
import { MAX_STATUS_PAGES, clampIssue, clampIssueCode, type MerchantItemStatus, type MerchantStatusProvider, type MerchantStatusReport } from './merchant-status.js';

const API = 'https://graph.facebook.com/v21.0';
const PAGE_SIZE = 100;

interface MetaProduct {
  retailer_id?: string;
  review_status?: string;
  errors?: { type?: string; title?: string; description?: string }[];
}

interface MetaPage {
  data?: MetaProduct[];
  paging?: { next?: string };
}

/**
 * Whether Meta is serving this row.
 *
 * `pending` counts as serving. Every newly added product passes through it for a while, so treating
 * it as a failure would fire an alert on ordinary product creation — and an alert channel that goes
 * off every time a seller adds a shirt is a channel that gets muted, after which the real one is not
 * delivered either (`error-severity.ts` makes the same argument about client errors).
 *
 * An ABSENT `review_status` is treated as serving too. It means Meta returned the row but not that
 * field, which is a shape problem and is caught one level up — inventing a rejection from a missing
 * field would blame sellers for our own parsing.
 */
function isServing(product: MetaProduct): boolean {
  const status = product.review_status?.toLowerCase();
  return !status || status === 'approved' || status === 'pending';
}

export function createMetaCatalogProvider(catalogId: string, accessToken: string): MerchantStatusProvider {
  return {
    network: 'meta',

    async fetchStatuses(): Promise<MerchantStatusReport | null> {
      const items: MerchantItemStatus[] = [];

      const first = new URL(`${API}/${encodeURIComponent(catalogId)}/products`);
      first.searchParams.set('fields', 'retailer_id,review_status,errors');
      first.searchParams.set('limit', String(PAGE_SIZE));
      // In the query string, not a header: Graph accepts either, and the paging URLs Meta returns
      // carry the token themselves — so following `paging.next` verbatim keeps working without this
      // module having to re-attach anything.
      first.searchParams.set('access_token', accessToken);

      let url: string | undefined = first.toString();

      for (let page = 0; page < MAX_STATUS_PAGES && url; page++) {
        let body: MetaPage;
        try {
          const res = await outboundFetch(url);
          if (!res.ok) return null;
          body = await res.json() as MetaPage;
        } catch { return null; }

        // Shape check — an unrecognised 200 is "no answer", never "no problems".
        if (!Array.isArray(body.data)) return null;

        for (const product of body.data) {
          if (!product.retailer_id) continue;
          const error = product.errors?.[0];
          const code = clampIssueCode(error?.type);
          const text = clampIssue(error?.title ?? error?.description);
          items.push({
            itemId: product.retailer_id,
            approved: isServing(product),
            ...(code ? { issueCode: code } : {}),
            ...(text ? { issue: text } : {}),
          });
        }

        url = body.paging?.next;
        // A `next` still waiting when the last allowed page has been read means `items` is a prefix.
        if (url && page === MAX_STATUS_PAGES - 1) return { network: 'meta', items, truncated: true };
      }

      return { network: 'meta', items };
    },
  };
}
