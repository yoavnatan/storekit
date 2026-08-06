---
name: feedback-roi-check-before-grinding
description: "Before committing to more rounds of a decomposable task, measure actual ROI against the stated goal and surface it plainly — pivot to a lighter/opportunistic mode instead of silently grinding"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f73042cf-3af0-47ae-8f6a-8bf785a09a7e
---

During the dashboard.css→Tailwind migration ([[feedback_css_migration_pace]]), pacing had already been lightened once (batch sections, skip Playwright on mechanical swaps, stop byte-counting every round) — but 10 rounds in, the actual measured result was only ~5% gzip reduction, far below what the effort implied. The user's real goal turned out to be different from the one originally stated (reducing future-session context load, not page-load performance) — this only surfaced because the real cumulative number was reported honestly instead of assuming the approach was working.

**Why:** grinding through many more rounds on an unexamined premise wastes real effort on a goal that may not even be the true one. The fix isn't more rigor mid-task — it's periodically stepping back and checking the actual payoff against what was actually wanted.

**How to apply**, for any multi-round/decomposable task (migrations, refactors, cleanup projects, anything worked in repeated rounds):
1. After a few rounds, measure the **cumulative actual result** vs. the **stated goal** — not just "did this round succeed."
2. If the real payoff looks weak relative to remaining effort, say so plainly with the numbers, unprompted — don't keep executing rounds quietly hoping it improves.
3. If the measured benefit doesn't match the stated goal, ask what the user's real underlying goal is — it may differ (here: context-reduction, not perf).
4. Default response to weak ROI is neither "stop entirely" (loses forward progress) nor "keep grinding at the same intensity" (wastes effort) — propose a **lighter/opportunistic middle path** (e.g. "convert on contact": only do the work when already touching the relevant files for something else) and let the user pick.
5. Once a policy shifts to opportunistic/permanent-background mode, move the durable rule into a permanent doc (e.g. `AI_INSTRUCTIONS.md` hard rules) rather than leaving it in a live task file — the live task file (`CURRENT_TASK.md`) should hold only currently-active instructions; a "from now on, always" policy belongs in the permanent rules file.
