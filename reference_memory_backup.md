---
name: reference_memory_backup
description: Where Claude Code memory is backed up and how to restore it on a new machine
metadata:
  type: reference
---

Memory is versioned in a **separate private GitHub repo** `yoavnatan/storekit-memory`, checked out at `.claude-memory/` inside the main project (git-ignored by the main repo, symlinked to the harness memory path). The main repo `storekit` is kept clean of memory so it can safely go public.

- **Auto-backup:** `.githooks/pre-push` in the main repo commits + pushes memory on every `git push` of the code (enabled via `core.hooksPath .githooks`).
- **New machine:** clone `storekit`, then run `bash scripts/setup-claude-memory.sh` — it clones the memory repo, rebuilds the symlink, and enables the hooks.
