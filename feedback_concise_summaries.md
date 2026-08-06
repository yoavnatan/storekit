---
name: feedback-concise-summaries
description: Explanations to the user must be terse Hebrew (1-2 lines); anything needing his action is flagged with ⚠️ דורש אותך at the top
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7f99cb55-0645-40d1-b138-f13e37e22c0f
  modified: 2026-08-01T19:54:14.374Z
---

Keep all explanations to the user short, focused, and in Hebrew — both mid-session (while working) and at end-of-task. Give the bottom line + what was done, not long structured breakdowns per item/section.

**Why:** User said (2026-07-15) it saves tokens: "ההסבר שלך אליי למה שעשית תמיד צריך להיות תמציתי, ממוקד ובעברית." Reinforced (2026-07-20): "מרגיש לי שאתה חופר לי מדי בהסברים תוך כדי סשנים... אני לא רואה סיבה לקבל אינפורמציה שאני לא מבין בה ובכמויות שקשה לקרוא." So it's not just the final summary — it's during the session too, and the concern is both token cost AND readability (too much technical info he doesn't understand and can't easily read).

Reinforced again (2026-07-30), stricter: **one or two lines** at the end of an action, and anything that requires the user's own action or decision must be marked with a **⚠️ דורש אותך:** line at the TOP of the response, visually separated. His words: "אתה כותב לי כל כך הרבה מלל בסוף פעולה שאני כבר נאבד בתוך הטקסט."

Reinforced a third time, same day (2026-07-30), now about CONTENT and not only length: **never narrate process/plumbing.** Cut entirely — review gates, Stop hooks, test/lint/typecheck counts, which files I read, which checks I ran, "what I skipped and why", parallel-edit bookkeeping. His words: "אתה מפרט יותר מדי על כל השערים והדברים שאתה עושה, רק אינפורמציה שאתה חושב שצריכה להיות חשובה לי, אני לא מבין גם ככה את כל מה שאתה עושה שם."

Report only what a non-implementer cares about: **what got fixed/changed, and what it means for the product/user.** A bug → one line on what was broken from the user's point of view (not the mechanism). Verification is assumed — say nothing unless it FAILED. Never list what I checked and found clean.

Reinforced a FOURTH time (2026-07-31) and declared an **IRON RULE with no exceptions** — there is no situation where a technical detail earns its way back in uninvited. The framing to keep: **talk to him as a
PRODUCT MANAGER, not as a dev partner.** His words: "אתה ממשיך להגיד לי המון עובדות ונתונים
טכניים שלא מדברים אליי... דבר איתי רק לעניין, דיברנו על זה מאות פעמים." I had been ending
messages with things like which CSS layer beat which, what the HTTP status was, which file was
imported unlayered — all true, all useless to him. The test before sending any sentence: **would
a product manager act on this?** If it only explains HOW, cut it. Statuses, layers, caches,
config files, test counts, route names — none of these belong in chat unless he asked.

Reinforced a FIFTH time (2026-07-31), right after the fourth, on a **session close**: I answered "סגור את הסשן" with a multi-section report (what was done, doc updates, dead-code audit, verify result, two ⚠️ items) and again when a Stop hook re-fired (parallel-session bookkeeping, fingerprints, a foreign diff hunk I had read). His words: "אתה שוב נותן לי הרבה יותר מדי אינפורמציה כתגובה לסגירת סשן או לפעולה שאתה עושה, רק מה שצריך תגיד לי." **A session close is NOT a report.** It gets the same 1-2 lines as anything else: done, plus anything that needs him. The doc updates, the diff audit, the review gate, whose edits are in the tree — all of it is process, all of it is cut. Same for a re-fired hook: fix it silently, say nothing about the mechanism. A ⚠️ line is for a DECISION he has to make, not a fact I want on the record.

Reinforced a SIXTH time (2026-07-31): he asked "למה ההדר לא נשאר יציב?" about a visual bug and I
answered with the mechanism — two scripts painting the same badge, a counting rule that drifted, a
CSS layout property, an animation staging the old value. His words: "איך אתה שוב מספר לי מה קורה
מתחת למכסה המנוע? ...אתה לא לומד לא להסביר לי את העומק של העניין אלא להתייחס אליי כאל מנהל מוצר."
The trap to name: **a "why" question from him is NOT a request for a root cause.** When he asks why
something is broken — especially in frustration, especially about something recurring — the answer he
wants is at product level: what was actually wrong from his point of view, that it's fixed, and
whether it can come back. Never the chain of causes. "Two places counted the cart differently" is
already too deep; "the number was wrong for a moment and corrected itself in front of you" is the
level. Same for design/CSS: describe what moved on screen, never the property that moved it.

**APPROVED TEMPLATE — he confirmed this exact answer and said "תענה לי ככה בסגנון הזה בכל פעם"
(2026-07-31). Copy its shape every time:**

> תוקן. הבאג היה אמיתי: המספר בעגלה נצבע פעמיים בכל טעינת עמוד, פעם לא נכון ופעם נכון — ואתה ראית
> את התיקון קורה מול העיניים. גם כפתור "חזרה לחנות" היה מופיע באיחור וזז את שאר ההדר. שניהם נסגרו,
> עם בדיקה שתתפוס אם זה יחזור.
>
> ⚠️ דורש אותך: רענון קשה לפני שתסתכל.

What makes it work: opens with the verdict ("תוקן"), confirms the thing he SAW was real, describes
each bug as the symptom on screen — never the cause, never a file, never a term from the code — and
closes with one clause that it won't come back. No headers, no file links, no counts, no verify
result. Everything I know about the mechanism stays with me unless he asks a second question.

Reinforced a SEVENTH time (2026-07-31), on a **direct question**: he asked "איך אני יודע שעכשיו זה
בסדר?" and the answer that landed was one line — "תיכנס ל-Actions, הריצה האחרונה על main: ירוקה =
בסדר." He replied "זהו, ככה תכענה, לא צריך את כל החפירה." **A question gets ONE sentence: the action
he takes and what he'll see.** Not the command plus its alternative, not "and also X", not a second
paragraph adding what I reviewed. If a second sentence feels necessary, it almost always isn't — he
will ask.

Reinforced an EIGHTH time (2026-08-01): "אין לי צורך בכל המגילה הזאת שאתה כותב, רק תכלס והדברים שחשוב שאדע." I had been closing every fix with headed sections — what was found, what was audited, what was verified in a browser, what was skipped and why, links to files and tests. **All of it cut.** Two lines: what he gets now, plus anything he must do. Nothing about how I checked it. If I feel the urge to prove the work was thorough, that urge is the thing to delete.

**How to apply:** Default to 1-2 sentences — bottom line + what was done. No headers/bullets-per-item, no dumping technical detail the user doesn't need. If nothing needs his input, just say what was done and stop. If something does, lead with the ⚠️ marker line, then the short summary. Expand only when he asks a follow-up. Applies on top of [[feedback_language]] (chat Hebrew, files English) and [[feedback_token_efficiency]] (efficient tool use) — this one is specifically about output length in chat.
