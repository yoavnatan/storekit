---
name: feedback_owner_prelaunch_items
description: "Standing rule (2026-08-06) — every owner-side pre-launch dependency is said to him in the conversation when the session touches it, and written into the GO_LIVE index the session it is created"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bb2acdb1-3007-45d5-8d0a-69ccd293715e
  modified: 2026-08-06T18:44:16.310Z
---

*"כל דבר שהוא אמור להיות באחריותי לפני עלייה לאוויר — זה משהו שאתה אמור להגיד לי כשמגיעים אליו…
אני לא צריך כל פעם להזכיר לך לכתוב את זה בגו לייב."*

Two obligations, both unprompted:

1. **Say it in the conversation.** When a session's work touches an area with an open owner-side line
   in `GO_LIVE_CHECKLIST.md`, name it in the summary under `⚠️ דורש אותך`. He wants to learn what
   depends on him while there is still time, not at the end.
2. **Write it the same session.** A session that creates such a dependency — an account to open, a
   business number to decide, an env var to set — adds it to the index itself. Never wait to be asked.

**Why the rule exists, and the mistake that produced it:** asked "so will you remind me on launch
day?", the honest answer was no, so a production-only alert was built instead. He rejected that
sharply — *"התכוונתי בהתכתבויות בינינו"*. **A runtime alert fires from a live site, which is after
the deadline it was meant to protect.** It is an acceptable last-resort net and never a substitute
for telling him beforehand. Same for a doc line nobody re-reads on the day.

**The mechanism, so this does not depend on any one session remembering:** `GO_LIVE_CHECKLIST.md`
opens with a `⚠️ דורש אותך` index — accounts to open, business decisions, production env vars,
one-time owner actions — as pointers to the sections, never duplicated text. The rule itself is in
`AI_INSTRUCTIONS.md` → Proactive obligations, which every session reads at start
([[feedback_read_instructions]]).

Related: [[reference_go_live_checklist]], [[feedback_concise_summaries]], [[feedback_fix_dont_report]],
[[project_merchant_status_monitor]]
