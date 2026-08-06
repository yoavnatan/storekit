---
name: project_order_card_layout
description: Collapsed order-card row (seller + admin Orders tabs) — the owner-decided constraints and how to avoid the redesign loop
metadata: 
  node_type: memory
  type: project
  originSessionId: e807cf78-e75b-4e14-ad0c-3049166489c3
  modified: 2026-07-31T13:27:38.649Z
---

Three renderers must stay identical: seller SSR (`src/pages/seller/dashboard.astro`), seller client `buildOrderCard` (`src/scripts/dashboard/orders.ts` — moved out of dashboard.astro in the orders.ts/messages.ts split, 2026-07-27), admin (`src/components/admin/AdminOrdersPanel.astro`). User calls a card "התראה". What the layout IS lives in AI_INSTRUCTIONS "Orders — seller"; this file holds only what the owner decided and why.

**Owner rules on the collapsed card — do not undo (each cost several rounds):**
- The **price must be column-aligned across all cards.** That is the whole reason the status cluster has a fixed width — a natural/`shrink-0`-only width makes the cluster vary and the price drifts card-to-card. The slot is **13.5rem**, not the 12rem it was: at 12rem the longest real pair ("טרם נשלחה · N ימים" + note chip + "בטיפול" = 210px) overflowed and the chip printed straight through the price.
- The age chip sits **packed against the note/status**, not floating in its own middle column (owner req 2026-07-26; supersedes an earlier "three separate side-by-side slots" shape).
- Cluster children never flex-shrink — the owner caught the chip's 11px clock SVG visibly squishing when they did. **The chip slot is the one exception (2026-07-31): it may shrink and CLIP (`min-w-0 overflow-hidden`), which is how the longest chip stops printing through the price. That only holds because the chip span itself is `shrink-0` in `order-age.ts` — without it the squeeze lands on the icon and the SVG measured 0px wide. Slot shrinks, chip never does.**
- **Price format:** `formatPrice` = `"195 ₪"` (number then ₪), rendered plain RTL and **left-aligned in its fixed slot** so every card's ₪ lines up. Do NOT right-align it and do NOT add `dir="ltr"` — that wrongly put ₪ on the right for Hebrew. Client `fmtPrice` uses `toLocaleString` so there's no trailing `.00`. **That fixed slot is the DESKTOP row only (2026-07-31).** In the narrow grid the price drops the `w-[6rem] text-end` and goes `text-start` in grid column 1, so it ends at exactly the same x as the order id and the date above it — owner: a price in its own floating slot "לא קשור לכלום". Verified: id/date/price all share one right edge at 375/414/520.
- Mobile trailing stacks to 2 lines (was 3) — owner preferred this. **Superseded 2026-07-31:** stacking the trailing column let the cluster claim its full 186px min-content beside the buyer name, so the card's min width was 479px against a 343px viewport — it scrolled sideways and the buyer name was squeezed to literally 0. Narrow layout is now a **container query on the card** (`@container/ordcard`, flips at 640px of the card's CONTENT box, so ~643px border-box), not `sm:` — the admin copy sits beside a sidebar, where viewport width says nothing about the card's room. Below it the header is a 3-column grid and the two wrappers go `display:contents`: row 1 = id/date · buyer · chevron, row 2 = price · status cluster. Guarded by `tests/order-card-layout.test.ts` (asserts all 3 renderers agree and that no `sm:` returns).
- Admin has no note-icon (no seller notes there) but keeps the same structure for parity.

**Note-editing UI decisions:** the "(גלוי רק לך)" hint lives ONLY in the editor, never on the add button. Delete is an inline ✓/✗ confirm on the row, **no modal**.

**How the redesign loop was finally broken (the real lesson — [[feedback_live_visual_debugging]]):** minted a seller session token + admin cookie, drove Playwright against the user's already-running dev server, screenshotted at 420 and 1200, and iterated from what I SAW (overflow → clip → wrap). Do NOT reason about rem widths or mobile pixel budgets on paper — screenshot and look.

**No seller credentials? Measure a standalone harness instead (2026-07-31):** copy the header markup into a bare RTL page, inline the BUILT css from `dist/client/_astro/*.css`, drive Playwright at several widths. **Two traps that make it lie:** (1) the dev server keeps serving a cached CSS bundle without your new classes — always `npm run build` and read `dist`, never the dev inline `<style>`; (2) once you have edited the source, Tailwind no longer emits the OLD classes, so a "before" fixture silently renders without them and looks fine — `git stash push -- <files>` + rebuild to get a truthful baseline. Both bit this session; the second nearly had me "fix" a regression I had not caused. Also give the harness `body{display:flex}`-proof width (`.wrap{width:100%}`) — the site's body is a flex column and a content-sized wrapper collapses once `container-type` is in play.
