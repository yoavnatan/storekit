---
name: feedback-verify-before-recommending
description: "verify a framework/library's actual default behavior before presenting an architectural option as cheap/safe — don't reason from general impression"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 12cd9e8e-b1c6-4703-9b37-2743944b4630
---

Before presenting an architecture option as "scoped"/"low-risk"/"cheap", verify the framework's actual default behavior for the specific mechanism involved (read docs or source, don't reason from a general impression of how the feature "probably" works).

**Why:** In the [[project_header_layout]] flicker investigation (2026-07-16, session ג׳), proposed a "scoped ClientRouter pilot" (only intercept home↔store links, `data-astro-reload` elsewhere) as the cheap middle ground vs. a full site-wide migration — without first confirming Astro ClientRouter's actual interception model. Turned out ClientRouter intercepts *all* same-origin links by default once mounted (opt-out per link via `data-astro-reload`, not opt-in per link) — so the "scoped" version required tagging every other link site-wide, i.e. the same blast radius as the "expensive" option already ruled out. Had to walk the recommendation back mid-implementation after the user had already said yes and work had started. The user directly called this out: "איך גם פה לא עשית את הארכיטקטורה הנכונה מההתחלה?"

**How to apply:** When recommending between architectural options and one is pitched as "scoped"/"safe", actually check (via docs/source/a quick test) that the scoping mechanism works the way assumed *before* presenting it as an option to the user — especially for opt-in-vs-opt-out semantics, which are easy to get backwards. Cheaper to verify for 2 minutes than to reverse a decision the user already approved.
