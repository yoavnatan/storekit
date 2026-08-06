---
name: feedback_security_priority
description: "Security is the owner's top priority — validate on the server, re-validate every price, trust nothing from the client"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bbab661f-8f8c-43e8-be67-9a4aeee14a87
  modified: 2026-08-05T13:56:16.884Z
---

Security outranks speed, polish and scope. Every API route is directly callable, so a rule enforced
only in the UI is not enforced: validate on the server even when the form already did, re-compute every
price from stored data rather than reading it off the cart, and treat every request-supplied string as
hostile.

**Why:** stated by the owner as a standing priority, and earned since — the holes that actually shipped
here were all one of these three ([[project_attribute_escaping_xss]], [[project_json_script_xss]],
[[project_safe_redirect]], [[project_checkout_idempotency_ownership]]).

**How to apply:** the concrete guards live in `src/lib` with grep-based tests that fail if anyone
hand-rolls a second copy — `safe-redirect.ts`, `image-url.ts`, `request-body.ts`, `email-address.ts`,
`money.ts`. Reach for the existing module before writing a check. On finding a hole, see
[[feedback_fix_security_dont_report]] (fix it, audit the whole class, add the guard) and
[[feedback_bug_defence_layers]] (on money, build every layer).

This index entry existed for weeks pointing at a file that was never written; restored 2026-08-05.
