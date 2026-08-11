# Seller dashboard: one panel per request

**Status (2026-08-11): DONE — steps 1–3 built and measured, step 4 CLOSED by the owner.** The weight
half shipped. The refresh-on-RE-open half was costed, judged weak ROI and dropped the same day;
step 4 below records what it would have taken and why it is not worth it. **Do not re-propose it**
without a new reason — the cost estimate there is the one that was rejected.

Measured on the built server against the demo catalogue, same seller, before and after:

| landing tab | before | after |
|---|---|---|
| סקירה כללית | 923KB · 1.14s | **163KB · 0.77s** |
| הזמנות | 923KB | **189KB** |
| הגדרות | 923KB | **188KB** |
| מוצרים | 923KB | 803KB |

Products barely moves because its own table IS that weight — 20 rows, each carrying a full inline
edit form. That is now the one thing left worth measuring on this page, and it is a different fix
(render the edit form on demand, not per row).

Driven in a real browser afterwards: all ten tabs fill on the click that opens them, no console
errors, and a control the SHELL script owns inside a lazily-filled panel (the add-product toggle)
still answers.

**Two problems, one fix.** Both were reported by the owner and neither is fixable without the other:

1. **Weight.** `/seller/dashboard` renders all ten panels on every request — ~865KB, of which ~73%
   is never seen. Memory `project_dashboard_html_weight`.
2. **Freshness.** Opening a tab shows the snapshot the document loaded with. The admin dashboard
   already refreshes a panel on open (`lazy-panels.ts` + `lib/panel-freshness.ts`, 2026-08-11); the
   seller cannot, because there is no way to ask the server for one panel.

Building the refresh first would mean fetching 865KB to use 10% of it, on every tab open, on
mobile. Building the weight fix first makes the refresh nearly free — and the refresh code does not
change when it lands, so nothing gets written twice. Hence this order.

## What `?panel=` does today, and what it must do

`seller/dashboard.astro:177` reads `?panel=` and uses it **only to choose which panel is not
`hidden`**. Every panel is built regardless. The admin's identical-looking parameter chooses **what
the server builds** — that is the whole difference, and it is the change.

Compare `admin/index.astro`, which is the worked example: `AdminPanelShell` renders an empty
container for every tab, the requested panel's contents are rendered into its shell, and
`initLazyAdminPanels` fills the rest on the click that opens them. `tests/admin-lazy-panels.test.ts`
pins that contract.

## Order of work

1. ✅ **The frontmatter's reads are conditional on the panel** (`only()` / `shows()`, the admin's own
   helpers). The sharing map that mattered: the catalogue is wanted by five panels, the category
   tree by three, and four reads are NOT gated because they are the tab strip's badges — a signal
   about a tab you are not looking at has to be computed anyway. The checklist behind the per-tab
   hints moved onto `getProductCountsByStore` for the same reason, and the platform-wide category
   vocabulary — which walked every visible store on EVERY load — is now read for two surfaces only.
2. ✅ **`components/dashboard/SellerPanelShell.astro`**, the twin of `AdminPanelShell`.
3. ✅ **Fill on open**, through `swapPanel` — which moved to `lib/panel-swap.ts` so both dashboards
   share one copy of the fetch-swap-stamp-or-navigate rule.

   Two things this uncovered, both silent, both fixed here rather than left:
   - The page's STAGE-1 script binds controls that live inside panels (the settings form, the
     add-product toggle, the hours editor, the overview's jump cards). None of them exists at load
     any more, so that pass runs again per panel — behind a per-element mark (`ui.ts#bindOnce`), or
     the second run would give the settings form a second submit handler.
   - `FormFallbackGuard`'s draft scan is a load-time pass over every form. Nine tabs' worth of forms
     were about to stop being drafted, and a draft that is not kept reports nothing. It publishes
     `window.__dashScanDrafts(root)` now, called after each fill.
4. ❌ **Refresh on RE-open — CLOSED, owner's decision 2026-08-11. Weak ROI. Do not re-propose.**

   **What it would cost.** The admin re-runs a panel's whole `init` after a refresh swap, because its
   modules are written to survive that. The seller's are not: about thirty of their listeners are
   delegated at the DOCUMENT (`products.ts` alone has a dozen), so a second `init` answers every
   click twice — a delete, a status change, a stock edit. Re-running is therefore off the table. What
   it needs instead is a THIRD phase per panel — `rebind`, the element-level half only, run after
   every swap — and deciding which of each panel's ~25 `init*` calls belong in it is a per-module
   audit of thirteen modules. That audit is the work; it is not a line of glue.

   **What it would buy, which is what settled it.** Step 3 already makes the FIRST open of every tab
   a fresh fetch, and the two tabs whose staleness has a business cost — orders and messages — poll
   every 15s on their own. So the entire remaining gap is the SECOND open of the same tab inside one
   page load, on a tab that is not orders and not messages: settings, promotions, reports,
   advertising, payments. Nothing there is a live figure anyone watches change, and a seller who
   wants it current reloads. Thirteen modules of surgery on the product's most important surface, to
   fix a stale number nobody has reported.

   **If it ever comes back**, the ground is already laid and this is the only part worth keeping: the
   panel loaders are two-phase for exactly this (`() => Promise<() => void>` — fetch the chunk, then
   wire), and `ui.ts#bindOnce` is the shape a `rebind` phase would generalise. The trigger to
   reconsider is a real report of a stale panel, not a tidiness argument.

   The same decision closes what step 4 was going to need: `hasUnsavedChangesIn(root)` was never
   written, because with no refresh to call it, it would be an exported function with no caller. The
   rule it was for is unchanged and still lives in `unsaved-guard.ts` — see the section below, which
   is now a record of the reasoning rather than an instruction.

## The constraint that outranked all of it — kept as the record, not as a task

With step 4 closed there is no refresh to constrain, and none of the code below was written. It
stays because the reasoning is the expensive part and the day someone builds a refresh here — on
this dashboard or another — it is the page that stops them doing it wrong.

**A refresh must never replace a panel holding unsaved work.** The owner raised this twice and it is
the thing to get right before anything else works nicely.

The authority is **`src/scripts/dashboard/unsaved-guard.ts`**, not the generic `panelHoldsTypedText`
written for the buyer and admin. That module already answers this question here — it keeps per-form
baselines, it is what `tab-sync.ts` asks before a cross-tab refresh, and its own comment says why:
*"a live cross-tab refresh must never redraw over work in progress, and this is already the one
place that knows what 'in progress' means."* A second definition of "in progress" on the same page
is the bug.

**But `hasUnsavedChanges()` as it stands is the wrong shape for this, and that has to be fixed
first.** It asks the WHOLE PAGE — `document.querySelectorAll(GUARDED).some(isDirty)` — which is
exactly right for its current caller, `beforeunload` and the cross-tab notice, where the question
really is "does this document hold unsaved work". A per-panel refresh needs "does THIS panel", and
using the global answer would let a half-finished product edit freeze the advertising tab, and every
other tab, until it is saved. Guarded forms live in products (add + inline edit), advertising,
settings, coupons, payouts and promotions, so in practice one open edit anywhere would block
everything.

Add a scoped variant **to that same module** — `hasUnsavedChangesIn(root: Element)`, sharing the one
`baselines` WeakMap and the existing private `isDirty` — and let `hasUnsavedChanges()` become the
document-scoped call of it. That keeps one definition of dirty, which is the whole point; a scoped
check re-implemented at the call site is the second definition this section is warning about.
`isDirty` is currently module-private, which is the right place for it to stay.

Note the interaction with step 1: today's behaviour is that leaving a tab mid-edit and returning
loses nothing, because panels are hidden and not destroyed. Lazy loading does not change that — it
only changes when a panel is built the FIRST time — but any design that *discards* a panel on leave
would break it, so do not.

**Do not add a new indicator** for a panel that skipped its refresh. The seller already has the
floating unsaved notice and the cross-tab notice; a third signal was tried as a dot on the tab and
rejected by the owner because it collided with the messages dot. Words, or nothing.

## Already true, so do not redo it

- Orders and messages on this dashboard poll every 15s (`scripts/dashboard/orders.ts:1144`,
  `scripts/dashboard/messages.ts:899`). Those are the two panels whose staleness has a business
  cost, and they are covered.
- **Only something that can make a panel current may stamp it fresh.** A partial poll must not — it
  runs inside the staleness window and would suppress the full refresh forever. This exact bug was
  written and caught in review on the buyer dashboard the same day; `tests/buyer-messages-refresh.test.ts`
  holds it there.

## Done when

`tests/seller-lazy-panels.test.ts` ✅ — the admin twin: a shell per declared panel, one panel's data
per request, the fill claiming the panel before it fetches, the wiring waiting for both the HTML and
the chunk, the shell-owned controls re-wired, the draft guard rescanned. Plus the invariant that
matters most on this page and has no equivalent on the admin's: **a badge read is never behind the
panel gate** — a dot that stops appearing is the failure nobody notices.

The three assertions this section used to also ask for — a re-open that keeps its filter params, that
the refresh asks `hasUnsavedChangesIn(panel)`, and that no second definition of "dirty" exists — all
belonged to step 4 and went with it. Nothing is untested as a result: there is no refresh for them to
have covered.
