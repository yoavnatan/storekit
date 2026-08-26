# Portfolio demo — the plan, and the audit behind it

**Decision, 2026-08-26 (owner).** This deployment is a **portfolio piece**, not a business. It must
look and behave like a live application to somebody who opens the link, while taking no money, no
card details and no real personal data. The commerce product is not abandoned — nothing here
deletes it — but the running site is a demonstration.

**The one sentence that governs every choice below:** *the demo must be indistinguishable from a
working app to a visitor, and must never be able to cost the owner an account, a quota or a
takedown.*

---

## What a visitor sees

The four showcase stores are the catalogue — 412 products with the Cloudinary images already
generated, curated Hebrew copy, variants. They are ordinary sellable stores here, each with a
seller, an approved merchant account and a paying subscription behind it.

Over them sits a lived-in layer: orders spread across three months in every status, reviews hanging
off real orders, returns in every scenario, analytics with a curve rather than a flat line,
campaigns with budget and spend, notifications and inbox threads, balances and reports with
numbers in them.

A visitor browses, searches, adds to cart and completes a purchase. Where PayMe's hosted card
iframes would mount, a labelled panel says the card form is served by the clearing company and is
disabled in the demo; the pay button still completes the order. The order then appears in the
seller dashboard and in the buyer's orders, exactly as it would in production.

Somebody who wants to try the seller side clicks the existing **פתח חנות** and registers normally.
Their store is real, their uploads are real, and the fake clearing takes them all the way to
publication. No separate "try me" path exists — the owner ruled that the real registration flow is
the better demonstration.

Quick-login buttons cover the *viewing* case: seller, admin, buyer, one click, no credentials.

**Every store that is not a showcase store is deleted** (owner, 2026-08-26). The demo database
holds four stores and nothing else.

---

## THE AUDIT — everything that could break this, found 2026-08-26

Three groups, in the order they would actually hurt.

### Group 1 — kills the whole site

| # | What | Where | Fix |
|---|---|---|---|
| 1 | **The Render hostname is not a platform host.** `isPlatformHost` compares the Host header against `platform.url`'s hostname (`dezabin.co.il`) plus loopback. Anything else falls through to custom-domain routing and answers **404 for every page on the site.** This is the single most likely way the first deploy comes up dead. | `src/lib/custom-domain.ts:265` | `PLATFORM_HOSTS` must carry the Render hostname, and `site` must come from the environment rather than the hard-coded constant. |
| 2 | **The server refuses to boot** without `AUTH_SECRET`, `ADMIN_SECRET`, `DATABASE_URL` — or with either secret still at its dev default. | `scripts/check-required-env.mjs` | Set all three on Render. This gate is correct; it just has to be satisfied. |
| 3 | **Nothing can be bought.** A production server whose payment provider cannot take money refuses to sell, by design and not by flag. | `src/lib/site-mode.ts:111` | `ALLOW_MOCK_CHECKOUT=1`. |
| 4 | **Migrations do not run themselves.** A fresh database answers every query with a missing-relation error. | `npm run db:migrate` | Runs as part of the deploy. |

### Group 2 — blocks a particular visitor

| # | What | Where | Fix |
|---|---|---|---|
| 5 | **Showcase stores refuse checkout.** `demo: true` returns 403 per item, deliberately. | `src/pages/api/checkout.ts:404` | Seed them without the flag on this deployment (`seed:showcase --live`). |
| 6 | **Admin is behind a password** nobody visiting has. | `src/lib/admin-auth.ts` | A quick-login button, valid only in demo mode. |
| 7 | **Google sign-in.** With the two variables set but the Render host absent from the authorised redirect URIs, the button renders and then fails on the way back — the worst of both. With them unset the button is not rendered at all. | `src/pages/api/auth/google.ts` | Leave Google unset until the owner adds the redirect URI, then set both. |
| 8 | **The card fields are PayMe iframes** that will never mount. Three empty `<div>`s, on purpose — the card number has never touched this origin. | `src/scripts/checkout-card.ts` | A labelled disabled panel in their place, buyer and seller side both. |
| 9 | **One IP for everyone.** Behind Render's proxy, without `TRUST_PROXY_IP` every visitor shares one address — and the limits are 30 registrations and **5 admin login attempts** per 15 minutes. The sixth wrong admin password locks the demo for every visitor at once. | `src/lib/rate-limit.ts:46-54`, `src/lib/client-ip.ts:27` | `TRUST_PROXY_IP=1`. |

*Checked and clear:* registration sends no verification mail — a new seller is logged in
immediately.

### Group 3 — the demo costing the owner something

| # | What | Fix |
|---|---|---|
| 10 | **The Cloudinary upload preset is unsigned and ships in the browser bundle.** On a public URL, anybody who reads the page source can POST any file to the owner's Cloudinary account without registering. Quota burn blocks *every* upload platform-wide; hosted content can mean suspension. **The most serious finding here.** | A **separate Cloudinary account** for the demo, with format and size limits on the preset. Same containment as the separate database. |
| 11 | **Image moderation is declared on but depends on a Cloudinary add-on.** If the add-on is not active on the demo's account, an uploaded image is stored unexamined. | Verify on the demo account; the separate account limits the blast radius either way. |
| 12 | **Outbound email.** Without `RESEND_API_KEY` `sendEmail` falls to the console adapter and nothing leaves the server. | Leave it unset. A demo that mails strangers' addresses is a spam complaint waiting to happen. |
| 13 | **Search indexing.** A demonstration indexed as a real Israeli marketplace is its own problem. | `SITE_NOINDEX=1`. |
| 14 | **Real personal data.** The business-details form asks for a תעודת זהות / ח״פ. | Prefilled demo values plus a note, so nobody types a real number into a demonstration database. |
| 15 | **The demo database is the dev database.** A purge of "every non-showcase store" against the wrong connection destroys the owner's own work. | A separate Neon branch, and the seeder refuses to run unless the database identifies itself as the demo one. |

---

## The work, in order

1. **Demo mode.** `DEMO_MODE=1` routes `sendPayme` (`src/lib/payment-payme.ts:212` — the single
   HTTP funnel every PayMe call passes through) to a local responder. Everything above it —
   merchant creation, approval, subscriptions, split capture, refunds, withdrawals — keeps working
   unchanged. Plus the disabled card panels of finding 8.
2. **Showcase stores live.** `seed:showcase --live`, and the checkout block lifts with the flag.
3. **The portfolio seeder.** One command composing `seed:showcase`, `seed:reviews`, `seed:returns`
   and filling what none of them cover: orders across three months and every status, analytics,
   campaigns with spend, notifications, balances, payouts. Purges every non-showcase store. Refuses
   to run outside the demo database (finding 15).
4. **The reset job.** Hourly, in the existing scheduler: restore the showcase stores, drop
   visitor-created accounts older than a day. Demo accounts cannot change their own email or
   password — an hourly reset is not fast enough to undo a lockout. Plus a manual reset for the
   owner.
5. **Quick-login buttons** — seller, admin, buyer. Demo mode only.
6. **Render.** `render.yaml`, `site` and hosts from the environment, migrations on deploy, the
   env matrix below.

## The Render environment

```
DATABASE_URL=<the demo Neon branch, not the dev one>
AUTH_SECRET=<fresh>            ADMIN_SECRET=<fresh>
DEMO_MODE=1                    ALLOW_MOCK_CHECKOUT=1
SITE_NOINDEX=1                 TRUST_PROXY_IP=1
PUBLIC_SITE_URL=https://<host> PLATFORM_HOSTS=<host>
PUBLIC_CLOUDINARY_CLOUD_NAME / _UPLOAD_PRESET = <the demo account>
RESEND_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, every PAYME_* — deliberately UNSET
```

## Needs the owner

A Render account (the free tier sleeps and cold-starts in about a minute, which a visitor reads as
a broken link — the paid starter tier is the difference), a separate Neon branch, a separate
Cloudinary account, and — only if Google sign-in is wanted on the demo — the Render host added to
the authorised redirect URIs.
