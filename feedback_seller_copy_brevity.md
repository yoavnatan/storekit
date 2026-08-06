---
name: feedback_seller_copy_brevity
description: Seller-facing copy (glossary/tooltips/hints) = the point only; never mix digits with Latin brand names inside Hebrew RTL text
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2e709b86-1866-4fcd-bc30-aa4bc6f2e31e
  modified: 2026-07-31T10:01:28.992Z
---

In-product Hebrew copy the seller reads — glossary entries, tooltips, field hints, empty states — carries **the point and nothing else**. Two or three clauses. Every qualifier, caveat and mechanism detail belongs in the code comment, `GO_LIVE_CHECKLIST.md` or `AI_INSTRUCTIONS.md`, not in front of the seller.

**And never put digits next to Latin brand names inside a Hebrew sentence.** "30 יום ב-Google, 7 יום ב-Meta" renders as visual soup in RTL — the reader cannot tell which number belongs to which name. Either drop the numbers or write the sentence without them.

**Why:** 2026-07-31, on the advertising glossary. I wrote a four-clause entry for "מכירות" holding the attribution window, the cross-device gap, the estimate caveat and a comparison to the Performance tab. The user: *"ארוך מדי והמספרים שם עם העברית והאנגלית מתחרבשים. צריך רק את הפואנטה."* I cut it, but kept a clause explaining why the number differs from the Orders tab — he cut that too: *"זה ברור מההסבר שהמכירות כאן מתייחסות למכירות שבאו מתוך הפרסום."* **The second cut is the real lesson:** the first sentence had already established the scope, so the explanation was re-stating what the reader had just understood. Before adding a clarifying clause, check whether the sentence above it already did the work.

**How to apply:** write the entry, then delete every clause that is not the single thing the seller needs in order to act or to stop being confused. Keep the removed detail — move it to the module header that owns the rule, so nothing is lost. Complements [[feedback_plain_language]] (that one governs vocabulary in CHAT; this one governs length and layout in the PRODUCT) and [[feedback_concise_summaries]].
