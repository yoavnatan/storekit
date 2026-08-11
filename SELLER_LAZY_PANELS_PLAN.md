# Seller dashboard: one panel per request

**Status:** decided, not started. Written 2026-08-11 as a handoff for a fresh session — the work is
too large to start at the end of a long one, and it touches the most important surface in the
product.

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

1. **Make the frontmatter's reads conditional on the panel.** This is the real work and where the
   bugs will be — the file loads orders, products, reports, payouts, campaigns and settings data at
   the top, and several panels share a read. Get the sharing map right before moving any markup:
   a panel that quietly needs a value the new condition skipped renders empty rather than throwing.
2. **A shell per panel**, so the container exists even when empty — the admin needed this because
   delegated listeners bind to the container once and must survive every swap.
3. **Fill on open**, through `swapPanel`, reusing `lib/panel-freshness.ts` exactly as the admin
   does: `markPanelFresh` inside the swap, `isPanelStale` on `dashtab:show`.
4. **Refresh on RE-open.** Same branch as `lazy-panels.ts`: a first open passes no params, a re-open
   keeps the panel's own.

## The constraint that outranks all of it

**A refresh must never replace a panel holding unsaved work.** The owner raised this twice and it is
the thing to get right before anything else works nicely.

Use **`hasUnsavedChanges()` from `src/scripts/dashboard/unsaved-guard.ts`**, not the generic
`panelHoldsTypedText` written for the buyer and admin. That module is already the authority on this
question here — it keeps per-form baselines, it is what `tab-sync.ts` asks before a cross-tab
refresh, and its own comment says why: *"a live cross-tab refresh must never redraw over work in
progress, and this is already the one place that knows what 'in progress' means."* A second
definition of "in progress" on the same page is the bug.

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

`tests/admin-lazy-panels.test.ts` has a seller twin: a shell per declared panel, one panel's data
per request, and a re-open that keeps its filter params. Plus a guard that the unsaved check is
`hasUnsavedChanges()` and that no second definition of it appears on the page.
