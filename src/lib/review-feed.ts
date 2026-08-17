import { xmlEscape, xmlCdata } from './xml-text.js';
import { RATING_MIN, RATING_MAX } from './reviews.js';

/**
 * The Google **product reviews** feed — schema 2.4, formatted.
 *
 * ── Which of the four Google review feeds this is ──
 * There are two programmes with confusingly similar names and they are NOT interchangeable. *Store*
 * ratings (`merchant_reviews/5.0`) rate the SELLER; *Product* ratings (this one) rate the goods, and
 * are what puts stars on a Shopping listing and a product rich result. Checked against
 * developers.google.com/product-review-feeds/schema + /sample on 2026-08-17 — the sample there is
 * what every element below is copied from, rather than from memory.
 *
 * ── The two facts our feed can state that most cannot ──
 * `is_verified_purchase` is unconditionally **true** and `is_incentivized_review` unconditionally
 * **false**, and both are honest by construction rather than by policy: a review here can only be
 * written against a paid, shipped order line (`review-eligibility.ts`), and the platform has no
 * mechanism to reward one. That is the strongest thing a review feed can say, and it is the direct
 * payoff of the purchase-required decision.
 *
 * ── What is deliberately NOT sent ──
 * `transaction_id` (the sample carries one). It would put an internal order id in a public,
 * unauthenticated document for an optional field that buys nothing — Google matches on the product
 * identifiers, not on it.
 *
 * ⚠️ **Meta has no counterpart and none is coming.** Meta's product-review feed schema belongs to
 * the Commerce Platform (Shops with Meta checkout), which this platform is not on, and the ordinary
 * catalog spec has no rating or review field at all — verified against
 * developers.facebook.com/docs/marketing-api/catalog/reference on 2026-08-17. Ratings reach Meta
 * only through the LANDING PAGE, which is why the Product JSON-LD on the product page carries
 * `aggregateRating`. Do not go looking for a Meta reviews feed to build; there isn't one.
 */

export interface ReviewFeedPublisher {
  name: string;
  favicon: string;
}

export interface ReviewFeedEntry {
  /** Permanent and unique — our review uuid. Required since 2024 (Merchant Center answer 14762988). */
  reviewId: string;
  reviewerName: string;
  /** ISO-8601, with an offset. */
  timestamp: string;
  content: string;
  rating: number;
  /** Where a person can READ this review — the product page's reviews section. */
  reviewUrl: string;
  productName: string;
  productUrl: string;
  brand: string;
  mpn?: string;
}

export const REVIEW_FEED_XML_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:vc="http://www.w3.org/2007/XMLSchema-versioning"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:noNamespaceSchemaLocation="http://www.google.com/shopping/reviews/schema/product/2.4/product_reviews.xsd">
  <version>2.4</version>`;

export const REVIEW_FEED_XML_FOOTER = `
  </reviews>
</feed>
`;

/** The publisher block + the opening `<reviews>`. Separate from the constant header because the
 *  platform's name and favicon are config, and `platform.url` is the value that changes on the
 *  go-live domain switch — nothing here may freeze it. */
export function reviewFeedPublisherXml(publisher: ReviewFeedPublisher): string {
  return `
  <publisher>
    <name>${xmlEscape(publisher.name)}</name>
    <favicon>${xmlEscape(publisher.favicon)}</favicon>
  </publisher>
  <reviews>`;
}

/**
 * Which language a review is written in.
 *
 * A guess, and a deliberately crude one: any Hebrew letter means Hebrew, otherwise English. The
 * field is optional, so the alternative to guessing is omitting it — but the site is Hebrew-first
 * with an English toggle, so "he" would be right for almost everything and declaring it lets Google
 * show the review to the right shoppers. Anything more (a real detector) would be a dependency for
 * a two-value answer.
 */
export function reviewLanguage(content: string): 'he' | 'en' {
  return /[֐-׿]/.test(content) ? 'he' : 'en';
}

/** One `<review>`. Text goes through CDATA like the product feed's title/description: a review is
 *  the one field on this platform a stranger writes, so it will contain `&`, `<`, quotes and
 *  emoji. */
export function reviewEntryXml(entry: ReviewFeedEntry): string {
  const anonymous = entry.reviewerName.trim() === '';
  const ids = [
    entry.mpn ? `          <mpns><mpn>${xmlEscape(entry.mpn)}</mpn></mpns>` : '',
    entry.mpn ? `          <skus><sku>${xmlEscape(entry.mpn)}</sku></skus>` : '',
    `          <brands><brand>${xmlEscape(entry.brand)}</brand></brands>`,
  ].filter(Boolean).join('\n');

  return `
    <review>
      <review_id>${xmlEscape(entry.reviewId)}</review_id>
      <reviewer>
        <name is_anonymous="${anonymous}">${xmlCdata(anonymous ? 'Anonymous' : entry.reviewerName)}</name>
      </reviewer>
      <is_verified_purchase>true</is_verified_purchase>
      <is_incentivized_review>false</is_incentivized_review>
      <review_timestamp>${xmlEscape(entry.timestamp)}</review_timestamp>
      <content>${xmlCdata(entry.content)}</content>
      <review_language>${reviewLanguage(entry.content)}</review_language>
      <review_country>IL</review_country>
      <review_url type="group">${xmlEscape(entry.reviewUrl)}</review_url>
      <ratings>
        <overall min="${RATING_MIN}" max="${RATING_MAX}">${entry.rating}</overall>
      </ratings>
      <products>
        <product>
          <product_ids>
${ids}
          </product_ids>
          <product_name>${xmlCdata(entry.productName)}</product_name>
          <product_url>${xmlEscape(entry.productUrl)}</product_url>
        </product>
      </products>
      <is_spam>false</is_spam>
      <collection_method>post_fulfillment</collection_method>
    </review>`;
}
