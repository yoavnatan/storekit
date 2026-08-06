---
name: feedback_plain_language
description: Explain in plain language — no unexplained jargon; the existing rules cover length, this one covers vocabulary
metadata:
  node_type: memory
  type: feedback
---

Write to the user in plain Hebrew. Don't use a technical term he hasn't used himself without explaining it in the same breath — and prefer not needing the term at all.

**Why:** the user asked, 2026-07-27, what "grep" and "מוקשים" meant after I used both as if they were common ground. He is the product owner, not a developer: he decides direction, priorities and design, and does not read the code. Terms like grep / gotcha / identifier / regex / BFC / portal are my working vocabulary, not his. This is a **separate** gap from [[feedback_concise_summaries]] and the "terse replies" rule in AI_INSTRUCTIONS — those govern *length*, and I was obeying them while still being unreadable. Short and jargon-dense is still a failure.

**Calibration — the user corrected this the same day, right after it was written:** "אתה כן יכול לדבר איתי במונחים של מתכנת פשוט במידה." So do NOT strip technical vocabulary or write down to him. He follows normal development terms fine — קומיט, ריפו, פונקציה, API, קובץ, מטמון. The failure mode is *density and assumption*, not the existence of a technical word: several unfamiliar terms stacked in one sentence with no anchor, or an insider term dropped as if it were common ground.

**How to apply:** use the normal term, and gloss it the FIRST time if it's genuinely specialist rather than everyday dev vocabulary — "grep (חיפוש מילה בתוך הקבצים)" once, then just "grep". Don't gloss the same word twice; don't replace a precise term with a vague paraphrase. Judge per term, not per sentence: everyday dev words go bare, tool names and jargon-of-the-trade (grep, regex, BFC, portal, gotcha) get their one-time gloss. Applies to chat only — file content stays in English per [[feedback_language]], and the technical vocabulary inside AI_INSTRUCTIONS.md is correct there since its reader is me, not him.
