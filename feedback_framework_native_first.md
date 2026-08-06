---
name: feedback-framework-native-first
description: Always check for Astro/framework-native solutions before building custom ones. User explicitly asked for this as a rule.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d3d94f67-7e29-4f8f-9414-59826a446868
  modified: 2026-07-23T20:47:49.753Z
---

Always look for the most architecture-aligned, framework-native solution BEFORE building a custom mechanism.

**Why:** User corrected me when I built `cdnSrc` (custom URL transformer) without first considering Astro's `<Image />` + `passthroughImageService()` approach. The Astro-native pattern was simpler, more maintainable, and more correct for this architecture.

**This applies to THIS REPO's own modules too, not just the framework.** Costly repeat (2026-07-23): asked to restore the store's scroll position on Back, I built a parallel sessionStorage handoff inside `StoreProductModal.astro` — while `src/lib/scroll-restore.ts` already implemented exactly that (save on pagehide, referrer-gated, `behavior:'instant'`, and crucially a load-more catch-up so a paginated grid is tall enough before restoring). Mine lacked the catch-up and fought the real one, so scroll visibly jumped then animated — the user said "you're getting tangled" and it took several failed rounds. The fix was to delete mine and add one small hook (`markStoreScrollReturn`) to the existing module.

**How to apply:** Before writing a custom utility or adding logic, ask:
1. Does Astro already have a built-in for this? (`<Image />`, View Transitions, prefetch, content collections…)
2. **Does this repo already do it?** grep `src/lib/` for the concept (scroll, restore, portal, ticker…) BEFORE writing a parallel mechanism — two systems for one job don't just duplicate, they actively fight each other.
3. Does the framework/stack already solve it? (Cloudinary URL API, Tailwind utilities, existing lib functions…)
4. Only build custom if the native/existing approach genuinely doesn't fit — and if you find one mid-way, delete yours rather than layering on top.

Related: [[feedback-tailwind-image]], [[feedback-architecture]], [[feedback-no-overthinking]].
