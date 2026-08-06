---
name: feedback-mobile-first
description: The entire app must be mobile-first responsive design — user explicitly requested this
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fdbdcbfb-9e15-4b4c-ad98-9284e70ce278
---

All UI must be built mobile-first. Design for small screens first, then scale up with media queries.

**Why:** User explicitly stated this is a requirement for the whole application.

**How to apply:** With Tailwind, write base classes for mobile, then add `sm:` / `md:` / `lg:` modifiers. Design for 375px first. Do not build desktop-only layouts.
