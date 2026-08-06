---
name: project_store_lifecycle
description: "Store pause/close model — built 2026-07-31; seller owns pause+close, admin owns block; closure DEFERS (never refuses) while orders are open"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3ff640e4-ec4a-47ba-b49c-2c43cc78737d
  modified: 2026-07-31T08:34:12.427Z
---

Store lifecycle built 2026-07-31 (CURRENT_TASK סשן א׳ item 1). Five states, one table in
`src/lib/store-status.ts`; transitions in `src/lib/store-lifecycle.ts`.

**The user's own framing, and it must drive the COPY:** הקפאה/סגירה is **not** "going on holiday".
He corrected this explicitly — a seller does not switch the site off to take a break; the site is
meant to be up all the time. Pausing is **operational** — a halt in activity, restocking, a move.
Never write "חופשה"/"vacation mode" anywhere.

**Seller-facing labels (settled with him 2026-07-31):** both verbs act on THE STORE — "הקפא את
החנות" / "סגור את החנות" — never on the sales. His reason, and it's right: the button should name
the STATE and the confirm dialog should explain the consequence, so the four state lines read as
one set (פעילה · מוקפאת · לקראת סגירה · סגורה). "עצור מכירות" was rejected because it left the two
buttons acting on different objects. The SHOPPER-facing copy deliberately does NOT use this
vocabulary — a buyer has no use for our state name, so they see "החנות אינה מקבלת הזמנות כרגע".

**Who:** the seller owns pause + close (zero-touch — nobody approves a seller stopping their own
sales); the admin keeps only `blocked`, which outranks every seller flag.

**The question he asked, and the answer built:** what about undelivered orders when the seller
wants nothing more sold? Those are two needs, so two mechanisms —
- pause = stops selling instantly, unconditionally; the store URL still answers 200 (no redirect,
  no 404, so no link breaks) but serves ONLY the notice — `Astro.rewrite` to
  `/store-unavailable?slug=`, before any catalog work. **The catalog is NOT shown** (his call,
  2026-07-31): a grid of products with every buy button disabled reads as a broken page, and a
  shopper can do nothing with a product they may not buy. I built it catalog-visible first and he
  pushed back — go with hiding it. Same for the store's product pages. noindex, out of
  discovery/feed; dashboard keeps working to fulfil. Open orders are UNAFFECTED by a pause —
  that question came up twice, so say it explicitly whenever pausing is discussed.
- close = never REFUSED when orders are open. It pauses and leaves the closure pending
  (`closing`), and `settleStoreClosure` finishes it by itself when the last open order closes.
  Refusing would mean coming back to press the button again = a manual step.

Closed = 410 Gone (drops from the index fast); blocked = 404. Both are served by `Astro.rewrite`
at the store's OWN url, never a redirect. **Trap, measured 2026-07-31:** Astro FORCES 404 on
anything rewritten to `/404`, so the 410 set inside that page was silently overwritten — hence the
separate `/store-gone` route. Nothing failed; found only by curling a real build.

**Shopper-facing copy for a closed store is neutral — "החנות אינה זמינה", never "החנות נסגרה"**
(user, 2026-07-31). His reason, and it generalises: closing is a business decision the SELLER
makes about their own store, not a penalty, and a public page must not announce that someone's
business shut down. The route name (`store-gone`) is the HTTP status; the words are not. Nothing is ever deleted — every
admin/reporting surface enumerates `getAllStores()`, so historical totals are untouched.

Boost campaigns follow automatically (a store that can't sell has no reachable products →
existing starve→pause path in `ad-campaign-health.ts`); only the final closure archives them.

**Unbuyable lines in cart + wishlist (his call, 2026-07-31):** a line whose product was
deleted/hidden or whose store stopped selling STAYS in the list, marked "לא זמין כרגע", out of
every total/count — never silently removed. He first thought they should vanish; the answer that
convinced him is that silent removal creates the confusion it tries to avoid (added three, sees
two, may believe he bought it), and that a paused store's product must come back on its own. Both
surfaces ask the same server question and the mark is set AND cleared. Fixing the wishlist
exposed that the CART had the worse bug — an unavailable line looked perfectly normal and the
buyer only found out at checkout.

Guarded by `tests/store-lifecycle-guard.test.ts` — reading `store.blocked`/`pausedAt`/`closedAt`
outside the owning modules fails the suite. That guard exists because the diff review found two
surviving `!s.blocked` copies answering the OLD question (admin ad-feed product count, and three
of four admin store lists). See [[feedback_new_state_sweep_consumers]], [[project_zero_touch_selfservice]].

Deferred with its trigger, logged in GO_LIVE §3: `/api/payment/confirm`, when built, MUST call
`settleStoreClosure` — a payment going 'failed' also unblocks a closure and nothing else would notice.
