---
name: feedback-design-philosophy
description: "Design must be 2026-relevant, mature, professional, modular — fits all store types"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b181424b-bfb3-4afe-9bf2-21fee7b99307
  modified: 2026-08-01T21:37:20.246Z
---

Design language must be:
- **Timeless/classic over trend-chasing** (confirmed 2026-07-10) — user explicitly said the goal is "עיצוב קלאסי, על-זמני," not chasing what's fashionable for a given year. When choosing between a trendy effect (glassmorphism, heavy neumorphism, seasonal color trends) and a restrained one grounded in basic light/shadow principles, prefer the restrained one — it won't look dated in a year or two. This reframes the "2026-relevant" line below: relevant means not dated (not Web 2.0/overdesigned), not "trendy for 2026."
- **2026-relevant UI/UX** — current patterns, not dated. Think modern e-commerce (not Web 2.0, not overdesigned).
- **Mature and professional** — no gimmicks, no clutter. Clean hierarchy, generous whitespace, purposeful typography.
- **Modular** — components must look right whether the store sells handmade jewelry, electronics, clothing, or food. No design that only works for one product type.
- **Content-agnostic** — colors, layout, and components adapt to the seller's brand; the platform chrome stays neutral.
- **Resilient to weak seller content** (added 2026-07-06, [[project_platform_name]] fixed-template decision) — since sellers get a fixed template with zero design effort (never a page builder — see AI_INSTRUCTIONS.md mission), the template itself must carry visual quality even when a seller's product photos are mediocre or products aren't visually striking. Consistent card framing, whitespace, shadow/border treatment (tactile-depth tokens), and image handling (crop/consistent aspect ratio, thumb generation) must make an average/weak photo still look acceptably professional — not just a great photo look great.

**Standing instruction, reconfirmed 2026-08-02 in the strongest form yet:** *"תמיד תתן לי עצות של עיצוב עכשווי שמתכתב עם האתר, גם אם אני אומר לך משהו אחר"* + *"חשוב לי שהעיצוב יהיה כמה שיותר קלאסי ועל זמני."* So an opinion is **owed, not offered** — if a treatment is dated or off the site's own language, say so plainly even when he has just asked for the opposite, and even when he only asked whether to keep something. He is asking to be argued with; agreeing to be agreeable is the failure mode here. The two words are not in tension: contemporary = free of a *previous* era's signature, and the way to get there is restraint, not a newer effect. **The worked case:** he asked whether the header's shadows felt cheap. They did — but the honest answer named which one and why: a drop shadow under a full-width bar is the 2015-18 Material signature, while a 1px rule is a typographic convention that dates to nothing. Two of three came out (the scrolled-bar shadow, the search-input focus shadow); the dropdowns kept theirs because there elevation IS the message. The third one that stayed — the store page's translucent filter row — kept it for a reason a border cannot cover: you can see through the surface, so only depth says which layer is in front. See [[project_tactile_depth_expansion]] and [[feedback_clean_design_line]].

**Why:** The platform serves any Israeli independent business, many of whom won't invest in product photography or design. Design that only looks good with great input content will make most real sellers' stores look bad — that undermines the entire fixed-template pitch (speed + zero design decisions).

**How to apply:** Before any UI decision, ask two questions: (1) does this look right for a clothing store AND a tech accessories store AND a food brand? (2) does this still look professional with a mediocre, badly-lit, or inconsistent product photo — not just a studio-quality one? If either answer is no, make it more neutral/modular/forgiving.
