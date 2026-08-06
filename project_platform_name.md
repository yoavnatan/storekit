---
name: project-platform-name
description: "Platform name is Dezabin (was ShopHub → Doochanim → ShopNest → Shopitka) — dezabin.com + dezabin.co.il owned; set in store.config.ts + translations.ts"
metadata: 
  node_type: memory
  type: project
  originSessionId: 39b5921e-a522-4c82-87cf-0ede3fbc9bbc
  modified: 2026-07-24T13:25:07.804Z
---

Platform name is **Dezabin** (decided 2026-07-24, session ד׳). Meaning hook: "דְּזַבִּין" from Chad Gadya (חד גדיא) = Aramaic for "that [he] bought" — literally "bought", fitting for a shopping marketplace. Brand-clean: no ecommerce/tech company by that exact spelling.

Domain **owned**: `dezabin.com` (primary/canonical) + `dezabin.co.il` (redirects 301 → .com for Israeli-buyer trust). Registrars: **dezabin.com → Cloudflare**; **dezabin.co.il → mynames** (bought for 74₪). DNS/nameservers for each live at its own registrar.

Previous names: ShopHub → Doochanim → ShopNest → Shopitka → **Dezabin**. The Shopitka→Dezabin switch (2026-07-24): user got anxiety that "Shopitka" was too close to Shopify (shared "Shopi-" stem) and to a dormant Lithuanian store-builder "Shopiteka" (1 letter off). Real driver was a brand-perfectionism/avoidance spiral more than the name itself — every candidate drew a "too similar to X" objection (Kaloota→"Kaloot"/"kalei-kaluta", Loota→crowded "Loot-" ecommerce cluster). Landed on Dezabin with genuine excitement. ~150₪ already spent on the abandoned Shopitka domains.

Set in `src/config/store.config.ts` (name, url→dezabin.com, legalName, email→hello@dezabin.com, logo.text, footer note, description) and `src/i18n/translations.ts` (footer note he + en). Also literal refs in `AdminAdvertisingPanel.astro`, comments in `brand-campaigns.ts` + `email/order-emails.ts`, `public/robots.txt` (Sitemap lines → dezabin.com), and test fixtures. All swapped 2026-07-24; tsc clean + 274/274 tests pass. CURRENT_TASK.md lines 99/101 still say shopitka.com — left for user (file is user-owned, [[feedback_current_task]]).

**Why:** User settled on Dezabin after a naming/anxiety spiral; name is distinctive, culturally rooted, fully available.
**How to apply:** Always use "Dezabin". Emails ([[project_messaging_email]], [[project_order_automation]]) render the name dynamically from store.name, so they update automatically. Still OUTSTANDING for go-live: CURRENT_TASK #12 (store.locale en_US → he_IL), register a Dezabin trademark (ILPO), DNS/email domain verification (SPF/DKIM, GO_LIVE §4), and manually fix the 2 shopitka.com refs in CURRENT_TASK.md. See [[project_domain_switch]].
