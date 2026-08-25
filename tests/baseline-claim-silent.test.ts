import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The platform campaign runs. It is never PROMISED.
 *
 *  Until 2026-08-25 the seller's Advertising tab opened on a "קידום בסיס · פעיל" card — the
 *  platform advertises your products on its own budget, included in the subscription — and the
 *  same claim was repeated on the pricing page and in the help centre. The owner removed the
 *  claim and kept the machinery: *"למה אני בכלל מציע קמפיין בסיס? זו הבטחה שאני לא יכול לעמוד
 *  בה"* … *"אני כן רוצה להיות מסוגל לעשות קמפיין בסיס, אבל מאחורי הקלעים. בלי להגיד את זה
 *  כהצהרה."*
 *
 *  The distinction is impossible to hold by memory alone, because the two halves live in the same
 *  files: `ad-baseline.ts` and the admin's per-store card must keep saying "we fund this", while
 *  every surface a seller can open must not. A single re-added sentence turns a marketing expense
 *  we control into an entitlement a seller can point at when the budget moves — and the budget is
 *  ours to move. So the boundary is a test, not a comment.
 *
 *  Scans SELLER- and BUYER-facing sources only. The admin surfaces (`/admin/**`, `admin-ads.ts`,
 *  `AdminAdvertisingPanel.astro`) are deliberately absent from the list: that is where the claim
 *  is TRUE and has to be readable.
 */

const ROOT = resolve(__dirname, '..');

/** Every file here renders to somebody who is not us. */
const SELLER_FACING = [
  'src/pages/seller/dashboard.astro',
  'src/pages/pricing.astro',
  'src/components/PricingTiers.astro',
  'src/lib/help-articles.ts',
  'src/i18n/translations.ts',
];

/** Phrases that state or imply the platform pays to advertise a seller's products. */
const BANNED = [
  'על חשבון הפלטפורמה',
  'על חשבוננו',
  'הקידום הבסיסי',
  'הפרסום הבסיסי',
  'פרסום בסיסי',
  'מקודמים כחלק מהקמפיין',
  "platform's budget",
  'baseline promotion',
  'baseline advertising',
];

/** Keys that legitimately hold baseline wording because ONLY the admin's per-store advertising
 *  page reads them (`src/pages/admin/store/[slug]/advertising.astro`). Anything else that starts
 *  carrying baseline copy has to be argued for here, in the open, rather than slipping in. */
const ADMIN_ONLY_KEYS = ['adBaselineTitle', 'adBaselineImpressions', 'adBaselineImpTip'];

/** A line that is prose ABOUT the rule — a comment — is not a claim to a seller. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*');
}

function isAdminOnlyKey(line: string): boolean {
  return ADMIN_ONLY_KEYS.some((k) => line.trim().startsWith(`${k}:`));
}

describe('the platform campaign is never claimed to a seller', () => {
  for (const rel of SELLER_FACING) {
    it(`${rel} promises no platform-funded advertising`, () => {
      const lines = readFileSync(resolve(ROOT, rel), 'utf8').split('\n');
      const hits: string[] = [];
      lines.forEach((line, i) => {
        if (isComment(line) || isAdminOnlyKey(line)) return;
        for (const phrase of BANNED) {
          if (line.includes(phrase)) hits.push(`${rel}:${i + 1} — "${phrase}" in: ${line.trim()}`);
        }
      });
      expect(hits, hits.join('\n')).toEqual([]);
    });
  }

  it('the seller dashboard renders no baseline figure at all', () => {
    const src = readFileSync(resolve(ROOT, 'src/pages/seller/dashboard.astro'), 'utf8');
    // Not just the words — the DATA. A number on the page is a claim even with no sentence
    // around it, and `storeBaselineStatus` is the only way to get one.
    expect(src).not.toContain('storeBaselineStatus');
    expect(src).not.toContain('ad-baseline-impressions');
  });

  it('still keeps the capability itself — the admin can see and fund it', () => {
    const admin = readFileSync(resolve(ROOT, 'src/pages/admin/store/[slug]/advertising.astro'), 'utf8');
    expect(admin).toContain('storeBaselineStatus');
    // The platform-wide budget control, the one place the campaign is actually funded.
    const panel = readFileSync(resolve(ROOT, 'src/components/admin/AdminAdvertisingPanel.astro'), 'utf8');
    expect(panel).toContain('platform-ads-form');
  });
});
