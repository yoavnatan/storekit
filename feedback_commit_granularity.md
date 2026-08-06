---
name: feedback_commit_granularity
description: "When a large uncommitted tree needs committing, split it into logical per-topic commits rather than one big commit — user's explicit choice 2026-07-30"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b36e0c97-7443-4a81-a04f-bd429b1f051a
  modified: 2026-07-30T10:37:32.793Z
---

When a big body of uncommitted work has to go in, the user wants it split into **several logical commits grouped by topic**, not one giant commit and not a narrow subset. Asked on 2026-07-30 with a ~250-file tree; he picked "everything, in a few logical commits" over both "all in one commit" and "only the originally listed files".

**Why:** a single commit makes it impossible to revert one topic later; a narrow subset leaves the rest of the tree uncommitted and makes CI run against a tree nobody verified.

**How to apply:** group by subject (tooling/gates, money+reporting, security, discounts, dashboard, buyer flow, images, storefront, SEO/admin, docs). Only the pushed tip needs to be green, so intermediate commits don't have to build. Verify the four CI steps against the working tree BEFORE committing, since a clean tree then equals the tip exactly. Related: [[feedback_workflow]], [[project_review_gate]].
