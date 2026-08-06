---
name: feedback-fix-dont-report
description: "any bug you find, you fix and report as done (✅); reporting a problem in a summary instead of fixing it is itself the failure — handing back a findings list is never the deliverable; binds EVERY session"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cb102e3c-e457-47bb-b2a7-d2df686e6bd6
  modified: 2026-08-04T19:01:11.476Z
---

**"כל השגיאות והבאגים שעלו וסיפרת לי עליהם, אתה מטפל? ההתנהגות הרצויה היא שתטפל ותגיד לי שטופל עם וי!"** — and immediately after: **"לא רק אתה אלא כל סשן שיתנהג ככה"** (2026-07-29). Written into `AI_INSTRUCTIONS.md` → Proactive obligations so it binds every session, not just the one that heard it.

**Why:** the user is the only person who can act on a findings list, and he can't — he doesn't hold the code in his head. A report without a fix converts my discovery into his backlog, which is a net negative: he now carries an obligation he didn't have before and can't discharge. He said it after I described several real bugs mid-session and moved on without closing them.

**Restated and widened (2026-07-30):** *"כל פעם שאתה מדווח לי בסיכום סשן על בעיה — תתקן אותה."* The trigger is **the act of reporting**, not the severity: if it is worth a sentence in the summary, it was worth fixing first. Said after I closed a summary with a stale brand name in `.env.example` labelled "cosmetic only" — even that is not a category that earns a mention instead of a fix. The test before writing any summary line: am I about to describe a problem I did not fix? Then go fix it and describe the fix. This also killed the "I flagged it, so I'm covered" move — twice in one session he asked "is anything left?", which is what it costs him to get a fix I should have just made.

**How to apply:**
- Found a real bug while doing something else? Fix it, test it, report it as ✅ done. "Out of scope" is not a category that applies to defects.
- About to write "worth knowing", "cosmetic only", "not fixed but harmless", or a bare observation of something wrong? That sentence is the signal to fix it instead. If it genuinely must not be changed (a real config value that only *looks* stale), fix the *confusion* — leave a comment saying why it stays.
- End of session: **re-read your own messages**. Anything you called broken and did not fix or explicitly defer is unfinished work.
- Report as a checklist of what is *done*, not what was *found*.
- Three exceptions only, and each must be said out loud rather than left silent: (1) blocked on a decision only he can make — say what you'd do and why you stopped; (2) the fix would be thrown away because a prerequisite doesn't exist yet (payment webhook with no provider) — log it in `GO_LIVE_CHECKLIST.md` / `DB_MIGRATION_PLAN.md` with its trigger; (3) genuinely ambiguous *business* semantics (what a headline should count, what a seller may do) — ask. **Size or awkwardness is not an exception.**

**Reaffirmed 2026-08-04, and exception (1) is narrower than it reads:** *"תניח שאם יש בעיה שאתה מוצא, הבקשה שלי תמיד תהיה — תתקן ותפתור לבד. בטח בעומק כזה של מורכבות."* Said after I found the feed/events identifier mismatch ([[project_ad_item_id]]), fixed only the half in front of me, and handed the rest over as "⚠️ דורש אותך — decide before launch". My reasoning was that picking the platform's permanent product identifier was a product decision with lasting consequences. **That reasoning is exactly the trap:** technical depth and cross-cutting reach are what make a thing MINE, not his — he cannot evaluate a tradeoff whose terms only exist in the code. Exception (1) is for a decision only he holds the inputs to (his money, his business, his risk appetite), never for one that is merely consequential or spans several files. When a fix touches many call sites and needs a design call, make the call, write down why, and say what would reverse it.

Stricter sibling for security gaps (also audit the whole class + add a guard test): [[feedback_fix_security_dont_report]]. Related: [[feedback_bug_defence_layers]], [[project_metric_integrity_audit]].
