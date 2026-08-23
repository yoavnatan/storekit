# PayMe's documentation, rendered and saved

133 pages of `payme.stoplight.io` and `docs.payme.io`, as plain text, captured 2026-08-23.

**Why it is in the repository.** Two of their sites are one JavaScript application: fetching either
returns a 447KB shell whose only readable text is the page title. Three sessions concluded from that
"PayMe's documentation cannot be read" and each one then designed against their OLD raw spec
(`../payme-api-blueprint.md`) or against a guess. Between them that produced a checkout built on the
wrong mechanism, an incorporation enum where two of three values were wrong, a merchant category
code from the wrong standard entirely, and two ceilings argued about in opposite directions on the
same day. Every one of those was answered somewhere in these files.

**How it was captured, and how to refresh it:**

    node scripts/scrape-payme-docs.mjs docs/payme-docs

That renders the pages in a real browser (Playwright, already a dependency), walks the navigation
and writes one `.txt` per page. **The obvious routes all fail and were each tried first** — there is
no `sitemap.xml`, a crawler user-agent is answered `403`, and their content API resolves the route
but wants an internal node id that is not the one in the address bar. A headless browser sidesteps
all of it, and it should have been the first idea rather than the last.

Duplicates are removed after a run: their navigation links the same article under `/branches/main/`
and `/branches/V1.6/` as well as at its canonical path.

## Where the useful pages are

| what you want | file |
|---|---|
| **multi-capture** — one authorization, one capture per seller | `docs_guides_4u5yp5vp5f41m-multi-capture-credit-cards.txt` |
| the 168-hour authorization window, and single-capture's "once only" | `docs_guides_5hztg1usesrsf-capture-sale-authorization.txt` |
| sale statuses / sale types / transaction statuses | `docs_guides_ort17682q5o8a-sale-statuses.txt`, `…okab0oj46ivn7-sale-types.txt`, `…jwbd2ca1avo63-transaction-statuses.txt` |
| callback attributes (⚠️ the SIGNATURE FORMULA is not here) | `docs_guides_i90qmmbdut067-sale-callbacks.txt` |
| **their Israeli MCC list** — their own numbering from 10000, not ISO 18245 | `docs_guides_u62g6pktpkr2t-israeli-mcc-list.txt` |
| **seller incorporation types** — 1 פרטי · 2 עוסק מורשה · 3 חברה בע״מ · 5 עוסק פטור | `docs_guides_s7t2zmnz2642i-seller-incorporation-type-il.txt` |
| Hosted Fields in the browser | `docs_guides_gsok0tstibqmz-hosted-fields-jsapi-guide.txt` |
| charging a stored token | `docs_guides_dpm16r1dqtjs0-create-payment-with-buyer-key-token.txt` |
| creating sellers | `docs_guides_7190ec6712209-how-to-create-new-sellers.txt` |
| test cards | `docs_payments_v781p5enpoq9x-test-cards-and-payment-methods.txt` |
| sandbox vs production hosts | `docs_payments_v4n3lbk5v9qpj-sandbox-and-production-ur-ls.txt` |
| subscriptions (the seller's monthly fee) | `docs_payments_567ad7df11de2-subscriptions.txt` |

**⚠️ "Generate Multi Checkout Payment" is not what its name suggests.** It is one payment page
offering several payment METHODS — card, bit, Apple Pay, Google Pay — and has nothing to do with
several sellers. The multi-seller mechanism is multi-capture, first row above.

**A page here is still weaker evidence than a measurement.** The ranking is in
`../payme-sandbox-notes.md`: what the sandbox actually did beats what they told us in writing
(`../payme-correspondence.md`) beats what a page says. This capture has already been wrong once
against a measurement — their own reference documents `market_fee` as `0–60`, which agrees, but
their raw spec's incorporation enum did not.
