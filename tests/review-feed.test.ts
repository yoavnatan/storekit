import { describe, it, expect } from 'vitest';
import {
  reviewEntryXml, reviewFeedPublisherXml, reviewLanguage,
  REVIEW_FEED_XML_HEADER, REVIEW_FEED_XML_FOOTER,
} from '../src/lib/review-feed.js';
import { feedBrand, feedMpn } from '../src/lib/product-feed.js';
import type { StoreProduct } from '../src/lib/store-products.js';

/**
 * The Google product-reviews feed document.
 *
 * Every element here was copied from developers.google.com/product-review-feeds/sample (checked
 * 2026-08-17), and the reason this file exists is the failure mode that feed formats have HERE: one
 * malformed value rejects the whole document, silently, and the symptom is ratings that never
 * appear (memory `project_feed_silent_rejection_class`). So the assertions are about the SHAPE, not
 * about prose.
 */

const entry = {
  reviewId: 'r-1',
  reviewerName: 'יואב נ׳',
  timestamp: '2026-08-17T09:00:00.000Z',
  content: 'איכות מצוינת & הגיע מהר',
  rating: 5,
  reviewUrl: 'https://dezabin.co.il/keramika/agartal#reviews',
  productName: 'אגרטל',
  productUrl: 'https://dezabin.co.il/keramika/agartal',
  brand: 'קרמיקה',
  mpn: 'SKU-1',
};

describe('the document frame', () => {
  it('declares schema 2.4 and its xsd', () => {
    expect(REVIEW_FEED_XML_HEADER).toContain('<version>2.4</version>');
    expect(REVIEW_FEED_XML_HEADER).toContain('product/2.4/product_reviews.xsd');
  });

  it('closes both elements it opens', () => {
    expect(reviewFeedPublisherXml({ name: 'Dezabin', favicon: 'https://dezabin.co.il/favicon.ico' }))
      .toContain('<reviews>');
    expect(REVIEW_FEED_XML_FOOTER).toContain('</reviews>');
    expect(REVIEW_FEED_XML_FOOTER).toContain('</feed>');
  });
});

describe('one review row', () => {
  const xml = reviewEntryXml(entry);

  it('carries the permanent id Google has required since 2024', () => {
    expect(xml).toContain('<review_id>r-1</review_id>');
  });

  it('states the two facts this platform can actually stand behind', () => {
    // Both are true by construction — a review needs a paid, shipped order line, and nothing here
    // rewards writing one. It is the direct payoff of the purchase-required decision.
    expect(xml).toContain('<is_verified_purchase>true</is_verified_purchase>');
    expect(xml).toContain('<is_incentivized_review>false</is_incentivized_review>');
    expect(xml).toContain('<collection_method>post_fulfillment</collection_method>');
  });

  it('sends the rating with its own scale attached', () => {
    expect(xml).toContain('<overall min="1" max="5">5</overall>');
  });

  it('sends brand, mpn and sku so the review can be joined to the product', () => {
    expect(xml).toContain('<brand>קרמיקה</brand>');
    expect(xml).toContain('<mpn>SKU-1</mpn>');
    expect(xml).toContain('<sku>SKU-1</sku>');
    expect(xml).toContain('<product_url>https://dezabin.co.il/keramika/agartal</product_url>');
  });

  it('omits the identifier block entries it does not have, rather than sending them empty', () => {
    const noSku = reviewEntryXml({ ...entry, mpn: undefined });
    expect(noSku).not.toContain('<mpn>');
    expect(noSku).not.toContain('<sku>');
    // Brand always survives: it is the fallback identifier, and `feedBrand` guarantees a value.
    expect(noSku).toContain('<brand>');
  });

  it('never leaks an internal order id', () => {
    // `transaction_id` is optional and deliberately not sent — this document is public.
    expect(xml).not.toContain('transaction_id');
  });

  it('survives the characters a stranger will actually type', () => {
    const nasty = reviewEntryXml({ ...entry, content: 'קניתי 2 < 3 & "מעולה" ]]> 🙂', productName: 'א & ב' });
    // CDATA, like the product feed's own free text — and the `]]>` split is what stops one review
    // from closing the section early and corrupting every row after it.
    expect(nasty).toContain('<content><![CDATA[');
    expect(nasty).toContain(']]]]><![CDATA[>');
    expect(nasty).toContain('🙂');
    // The URL/id attributes are escaped rather than CDATA'd, and an unescaped `&` there is what
    // makes a whole feed unparseable.
    const amped = reviewEntryXml({ ...entry, productUrl: 'https://dezabin.co.il/a/b?x=1&y=2' });
    expect(amped).toContain('?x=1&amp;y=2');
  });

  it('marks an empty reviewer name as anonymous rather than sending a blank author', () => {
    const anon = reviewEntryXml({ ...entry, reviewerName: '' });
    expect(anon).toContain('is_anonymous="true"');
    expect(reviewEntryXml(entry)).toContain('is_anonymous="false"');
  });
});

describe('the language guess', () => {
  it('reads a Hebrew letter as Hebrew and anything else as English', () => {
    expect(reviewLanguage('מעולה')).toBe('he');
    expect(reviewLanguage('Great product')).toBe('en');
    // A mixed review is Hebrew, which is the right answer for a Hebrew-first marketplace.
    expect(reviewLanguage('Great — איכות מעולה')).toBe('he');
  });
});

describe('the product identity is the SAME one the product feed publishes', () => {
  const product = { name: 'אגרטל', sku: 'SKU-1', brand: undefined } as unknown as StoreProduct;

  it('falls back to the store name exactly as the catalog feed does', () => {
    // Two feeds naming a different brand for one product is a review Google cannot join to the
    // item it reviews — which is why both call these two functions instead of deriving their own.
    expect(feedBrand(product, 'קרמיקה')).toBe('קרמיקה');
    expect(feedBrand({ brand: 'Acme' }, 'קרמיקה')).toBe('Acme');
  });

  it('drops an over-length mpn rather than cutting it', () => {
    expect(feedMpn({ sku: 'x'.repeat(71) })).toBeUndefined();
    expect(feedMpn({ sku: undefined })).toBeUndefined();
    expect(feedMpn(product)).toBe('SKU-1');
  });
});
