---
name: feedback_architecture
description: "Permanent modular architecture rules — black box, layer separation, SRP, no globals. Non-negotiable on every code change."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4b45c01f-5689-4489-aab6-23b00c187a85
---

The modular architecture rules are permanent and non-negotiable — not just guidelines, but the foundation of every code change. The user explicitly wants scalable code with no spaghetti. Future complex features must be addable without untangling monolithic files.

**Rules (always apply):**
1. **Black Box** — every feature, component, or page is self-contained. No monolithic files that do everything. UI components display data and receive props only — no complex business logic inside them.
2. **Layer Separation** — strict split between view layer (Astro UI) and data/business logic. DB operations, Cloudinary calls, external API calls → only in `/src/services/` or `/pages/api/`. UI components consume from there.
3. **SRP** — each function or file does one thing. File > 150–200 lines? Proactively split into sub-components or utils.
4. **No Global Pollution** — no global variables or hacky shortcuts. Use clear props and well-defined data models.

**Why:** The user is planning complex features down the road. Spaghetti code now means impossible refactors later. Architecture is the top structural constraint alongside SEO.

**How to apply:** Before writing or modifying any code, verify it meets this standard. If a planned change would violate these rules, restructure first, then implement.

**Tailwind migration strategy (progressive):** All new code uses Tailwind v4 utility classes only (no new CSS files). When touching an existing CSS file or component for any reason, convert it to Tailwind at that point. tokens.css stays as the base for runtime CSS variables (dynamic per-store theming). Never do a big-bang migration — convert on contact.
