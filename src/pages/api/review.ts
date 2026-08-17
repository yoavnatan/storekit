export const prerender = false;
import type { APIRoute } from 'astro';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';
import { clientIp } from '../../lib/client-ip.js';
import { checkAuthRate, countAuthAttempt, reviewRules, retryAfterMinutes } from '../../lib/rate-limit.js';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getOrderById } from '../../lib/orders.js';
import { orderCoversProduct } from '../../lib/review-eligibility.js';
import { verifyReviewToken } from '../../lib/review-token.js';
import { createReview } from '../../lib/product-reviews.js';
import { isValidRating, normalizeReviewBody, REVIEW_BODY_MAX } from '../../lib/reviews.js';
import { findSpamKeyword, findKeywordStuffing } from '../../lib/spam-filter.js';

/**
 * Write one product review.
 *
 * ── The authorization, in the order it has to happen ──
 * 1. The caller must produce an ORDER they own — either a session whose `buyerId` is on the row, or
 *    the signed link that was mailed to a guest (`review-token.ts`).
 * 2. That order must be in a state where its buyer may review (`review-eligibility.ts`, which reads
 *    the `buyerMayReview` column and not a status name).
 * 3. The product must be a LINE IN that order. **An id in a request body is a claim, never a
 *    permission** (memory `project_checkout_idempotency_ownership`) — without this step a valid
 *    order id would authorise reviewing the entire catalogue.
 * 4. One purchase, one review — enforced by `UNIQUE (order_id, product_id)` in the database rather
 *    than by a read here, because a read cannot win a race against a double tap.
 *
 * ── Why the answers are deliberately uniform ──
 * "No such order", "wrong token" and "not yours" all return the same 403. The three are the same
 * fact to an honest caller and three different oracles to a scripted one: distinguishing them turns
 * this endpoint into a way to confirm that an order id exists.
 *
 * ── The spam gate is not optional here ──
 * AI_INSTRUCTIONS has carried the rule since before there were reviews: buyer review text runs
 * through the SAME filter as seller copy. It is the only automatic gate on the one free-text field a
 * stranger can publish on a seller's page and — through the reviews feed — on Google, and this
 * platform has no moderation queue by design (zero-touch). Admin `blocked` is the cleanup after the
 * fact; this is the part that happens without anybody being awake.
 */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

interface ReviewBody {
  orderId?: unknown;
  productId?: unknown;
  rating?: unknown;
  body?: unknown;
  token?: unknown;
}

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  const read = await readJsonBody<ReviewBody>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ ok: false }, read.status);

  const rules = reviewRules(clientIp(request, clientAddress));
  const gate = await checkAuthRate(rules);
  if (!gate.allowed) {
    return json({ ok: false, throttled: true, retryAfterMinutes: retryAfterMinutes(gate.retryAfterSec) }, 429);
  }
  // Counted BEFORE the work, unlike `/api/report` — here the guessing is the abuse, so an attempt
  // that fails authorization is exactly the one that has to be paid for.
  await countAuthAttempt(rules);

  const { orderId, productId, rating, token } = read.value;
  if (typeof orderId !== 'string' || typeof productId !== 'string') return json({ ok: false }, 400);
  if (!isValidRating(rating)) return json({ ok: false, reason: 'rating' }, 400);

  const body = normalizeReviewBody(read.value.body);
  // Refused, never truncated: a review cut off mid-sentence is published words the buyer did not
  // agree to stand behind, and they have no way to know it happened.
  if (body.length > REVIEW_BODY_MAX) return json({ ok: false, reason: 'too-long' }, 400);

  const order = await getOrderById(orderId);
  if (!order) return json({ ok: false, reason: 'not-allowed' }, 403);

  const userId = getSellerSession(cookies);
  const ownsBySession = !!userId && order.buyerId === userId;
  const ownsByToken = verifyReviewToken(orderId, token);
  if (!ownsBySession && !ownsByToken) return json({ ok: false, reason: 'not-allowed' }, 403);

  if (!orderCoversProduct(order, productId)) return json({ ok: false, reason: 'not-allowed' }, 403);

  const spam = findSpamKeyword(body);
  if (spam) return json({ ok: false, reason: 'spam' }, 400);
  const stuffing = findKeywordStuffing(body);
  if (stuffing) return json({ ok: false, reason: 'spam' }, 400);

  // The store the LINE belongs to, never a value from the body — an order is single-store by
  // construction (checkout writes one row per store), so the item answers for it.
  const line = order.items.find((i) => i.productId === productId)!;

  const review = await createReview({
    productId,
    storeSlug: line.storeSlug,
    orderId,
    buyerId: order.buyerId ?? null,
    // The name on the ORDER, not one the caller may send — what gets published is derived from it
    // once, at write time (`reviews.ts#reviewerDisplayName`), so a review can never carry a name
    // its buyer did not give at checkout.
    buyerFullName: order.buyerName,
    rating,
    body,
  });

  // `null` is the unique constraint refusing a second review of one purchase. Not an error — it is
  // what happened, and the page says so instead of showing a failure the buyer cannot act on.
  if (!review) return json({ ok: false, reason: 'already-reviewed' }, 409);

  return json({ ok: true, review: { id: review.id, rating: review.rating, body: review.body, reviewerName: review.reviewerName, createdAt: review.createdAt } });
};
