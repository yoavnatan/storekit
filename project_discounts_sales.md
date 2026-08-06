---
name: project_discounts_sales
description: "Discounts & sales — the decisions behind the model (two levers, better-price-wins, one visual language) and the alternatives the user rejected"
metadata: 
  node_type: memory
  type: project
  originSessionId: fbd759a2-71ec-498d-818f-655a9233ddaf
  modified: 2026-07-29T18:50:30.929Z
---

Built 2026-07-29. The code is in `lib/discounts.ts` + the Features-built bullet in `AI_INSTRUCTIONS.md`; what follows is only what the code cannot tell a future session.

**Two levers, never a third.** A product's own discount, and a store sale whose scope is the whole store / one or more category subtrees / hand-picked products. "Selected products" was deliberately NOT given its own mechanism — the products-tab bulk dialog writes the same per-product record, and a store sale's product scope lives on the same `Store.sale` row. One thing to keep in sync, not three.

**Better price wins, decided by the user (asked, answered "הזול לקונה + להראות תוצאה").** First implementation had the product's own discount always win; that let a banner promise 30% while a product carrying its own 5% charged more than the banner said — a broken public promise, not a preference. The alternative he weighed and rejected: "per-product always overrides", which would have forced the banner to be worded "עד X%". His real concern was that explaining any rule complicates the seller — so the answer was to stop explaining and show the OUTCOME (each row in "מוצרים במבצע" shows the final price plus which lever decided it).

**Any scoped sale must name its scope** on every surface that announces it (banner subtitle, store-card chip drops the percent). A scoped sale shouting "-30%" across a whole store page promises what most of that page doesn't give. **EVERY scope names itself, the store-wide one included (2026-07-29, his question "האם זה כדאי?").** Only the narrow scopes spoke before, which left an unlabelled banner ambiguous between "covers everything" and "the seller forgot" — and "על כל החנות" is the strongest of the three claims anyway, not a caveat.

**Several categories per sale (2026-07-29, he asked for it).** He remembered it as already existing — it never did; what existed was a parent pick covering its descendants. On the banner wording he was undecided and picked, from three options: **names, up to 2, then "ועוד N"**. Rejected: always listing every name (wraps to two lines on a 375px banner and shoves the seller's own sentence aside) and a generic "על קטגוריות נבחרות" (says nothing the shopper can act on). A category name is a reason to click.

**The promotions category picker is choice-only.** He objected to "+ הוסף קטגוריה" living there: creating a category is a CATALOG decision, and offering it inside a sale form invites a seller to reshape a tree he can't even see from that screen. Same rule killed the empty arrow-gutter beside rows that no longer expand.

**One visual language for the buyer, on purpose.** He asked whether a product discount should look different from a store-sale discount; the answer was no — a shopper would have to decode our internal mechanics to know what he pays. He accepted it.

**Rejected — do not re-propose:**
- A shine/shimmer sweeping the banner's LETTERS (gaming/crypto aesthetic, and it drops contrast on the headline). The strip's own sweep already crosses them.
- The banner sweep replaying on hover anywhere on the strip — "עושה סחרחורת"; a full-width banner re-fired on every cursor pass. Hover now only nudges the percent pill (scale + darken); the sweep is an ARRIVAL gesture, once per page.
- An expanding white ring as the pill's pulse — read as a separate event competing with the sweep.
- Hover DARKENING the percent pill further (2026-07-29): it went the opposite way from the pulse, so the same chip had two different lit looks. Hover now settles on the pulse's own peak — one `--sale-pct-bg-lit` shared by the keyframe and the hover rule so they can't drift apart again.
- A percent column in the CSV alongside "מחיר מבצע" — two ways to say one thing is how a spreadsheet contradicts itself.

**Copy conventions he corrected:** toasts carry **no trailing period** (the rest of the app already didn't); "הנחה שתחול על מוצר מסוים", "מוצרים שתחול עליהם הנחה נפרדת"; the store-wide sale is **"מבצע רוחבי"**, never "מבצע הרץ".

**Contrast is measured, not eyeballed.** The percent pill started as a white tint over the green banner and measured 4.43:1 at rest / 3.41:1 on hover — under AA. It darkens the banner instead (8.8:1 / 10.5:1 hovered). Sample real rendered pixels (`sharp` is installed) rather than reasoning about alpha compositing.

Related: [[feedback_live_visual_debugging]], [[project_tailwind_hidden_vs_flex]], [[project_cart_auth_session]].
