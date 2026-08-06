---
name: feedback_fix_security_dont_report
description: "Never park a security gap as \"out of scope\" — fix it in the same turn, then audit the whole class across the codebase"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e2466b3a-647d-4549-a82a-fe4cd0f75e12
  modified: 2026-07-30T07:13:21.478Z
---

A security gap is never "beyond scope". Fix it immediately, in the same turn it's found — do not list it as a follow-up for the user to approve (user, 2026-07-29: "why did I have to suggest this to you? if there's a risk of a security leak or malicious injection you're supposed to act on your own").

**This is the strict case of a general rule** — [[feedback_fix_dont_report]] extends "fix it, don't report it" to *every* defect, for every session. Security keeps the two extra obligations below (sweep the whole class, leave a mechanical guard) because a security bug class regenerates; an ordinary bug usually doesn't.

**Why:** I found two real gaps during a security review and reported them as open items instead of fixing them. The user had to ask for the fix. Worse, his follow-up question — "how do I know there aren't more somewhere in the code?" — was the right one: auditing the class turned up **11 more live instances** of a third sink (raw `JSON.stringify` in `set:html`, including the JSON-LD on every public page). Reporting one instance leaves the class intact.

**How to apply:**
- Fix on sight, then audit the whole class across `src/**` — never just the instance in front of you. One finding means the pattern exists elsewhere; assume it does until a sweep says otherwise.
- Finish with a mechanical guard (a Vitest sweep that fails on the pattern), not a note in a doc. This codebase now has three: `tests/html-escape.test.ts`, `tests/json-script.test.ts`, `tests/image-optimization.test.ts`. That is what makes "how do I know there aren't more" answerable.
- Root cause worth remembering: this app builds HTML with string concatenation in ~25 client-side render paths, so escaping is manual by construction — the bug class regenerates unless the mechanism, not the site, is fixed. See [[project_attribute_escaping_xss]], [[project_json_script_xss]], [[feedback_security_priority]].
