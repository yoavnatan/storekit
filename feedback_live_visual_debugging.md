---
name: feedback_live_visual_debugging
description: When debugging a visual/layout bug live while the user watches via HMR, verify each incremental edit actually converges before moving on
metadata:
  node_type: memory
  type: feedback
  originSessionId: 27f83d32-3785-4b50-961a-06e90a214b88
---

When fixing a live-observed visual/layout inconsistency (the user is refreshing pages in their own browser while I edit CSS/JS that hot-reloads), measure the *actual delta* after every single incremental edit — not just after the final one — before letting the user look again.

**Why:** During the 2026-07-16 header/avatar-position investigation, one intermediate edit (making `.user-menu` a real flex container to remove a phantom line-height gap) was independently correct, but by itself it *increased* the measured cross-page Y-offset from ~0.1px to ~0.8px before the follow-up fix (`min-height` pinning) brought it to exactly 0. The user was watching live and reacted with "אתה שוב הורס, זה היה טוב ואז הרסת שוב" — from their vantage point a real regression, even though it was a correct step partway through a two-part fix. This pattern also matches the *previous* session's failed attempt on the same header bug (Playwright said fixed, user's real browser said worse) — recorded in [[feedback_current_task]].

**How to apply:** Before reporting any single edit as progress (or leaving it applied while investigating the next hypothesis) on a bug the user can already see live, re-run the same numeric/pixel check used to diagnose it and confirm the gap shrank, not just changed shape. If an edit is known to be correct in isolation but won't fully close the gap until a second edit lands, apply both before letting the user re-check — don't ship a partial state that can visibly regress one dimension while fixing another.

**Assert on what RENDERS, never on the class you just set (added 2026-07-29).** Closing the discounts session I hid a "you saved" row with `classList.toggle('hidden', …)` and verified it with `classList.contains('hidden')` — which passed, while the row stayed on screen showing "0 ₪", because it is a `flex` element and this build emits `.flex` after `.hidden` (see [[project_tailwind_hidden_vs_flex]] — the very bug already in memory). The check restated my own intent instead of testing the outcome; the user found it in one look. In Playwright assert `isVisible()` / computed style / measured pixels; in a unit test assert the value a consumer reads. A test that re-reads the state the code just wrote can only ever confirm the code ran, never that it worked.
