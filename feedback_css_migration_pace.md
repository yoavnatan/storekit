---
name: feedback-css-migration-pace
description: "How to pace verification during the dashboard.css/store.css Tailwind migration — batch sections, minimize Playwright, stop measuring gzip byte-by-byte"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 57cbef8d-eb7b-45d7-b8ed-0c57b64293c5
---

User flagged (2026-07-15) that the CSS→Tailwind migration ([[project_css_tailwind_migration]] if that memory exists, else see AI_INSTRUCTIONS.md → Hard rules → Tailwind v4 only) was taking too many rounds relative to progress. Concrete pacing rules going forward:

**Update (2026-07-15, later same day):** even after applying these pacing rules, 10 rounds only netted ~5% actual gzip reduction — the task was fully retired to convert-on-contact (see [[feedback_roi_check_before_grinding]] for the general lesson: check cumulative ROI periodically, don't just keep pacing the same grind faster).

- **Batch 3-4 CSS sections per round, not one.** Verification cost (tsc+build+test) is roughly the same whether converting 1 class or 20 — the ceremony was the bottleneck, not the conversion work itself.
- **Playwright only for genuinely interactive flows** (add/rename/delete, multi-step state like category-tree or category-picker's expand/select/add-category) — this already matches [[feedback_testing_strategy]]. Most of this migration is mechanical 1:1 class→Tailwind swaps with zero logic change; those need tsc+build only, no screenshot/interaction pass.
- **Stop reporting gzip size byte-by-byte every round.** Confirm "didn't increase dramatically," don't narrate the exact delta each time — the byte-level tracking was explicitly called out as not the actual goal.
- **CURRENT_TASK.md checkpoints must be short fact-lists** (what converted, verified y/n), not full Hebrew narrative paragraphs per round — git diff/history can supply detail if ever needed. This is stricter than the general [[feedback_concise_summaries]] rule, specific to this task's checkpoint entries.
- Do NOT relax: usage-verification before removing any class (checking all of src/ including dynamically-built JS markup) and the admin-shared-class checks (`.dash-tabs`/`.dash-panel`/`.dash-head`/`.card`) — user explicitly said keep that rigor, only cut the verification "ceremony" around it.
