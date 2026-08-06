---
name: project_permission_prompt_on_memory_writes
description: "Memory writes kept raising a permission prompt despite the allow rules — settled 2026-08-06 by a PreToolUse allow hook, because memory files can't grant permissions"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5e576945-02a1-446e-b4a7-fc128c14a057
  modified: 2026-08-06T16:38:54.280Z
---

A memory file is an instruction to **me**. The permission dialog belongs to the
**harness**, and the harness never reads memory. So [[feedback_edit_without_asking]]
and [[feedback_memory_write_no_asking]] can never stop a prompt on their own —
only `settings.json` can.

On 2026-08-06 a session stalled on "Allow write to project_custom_domain_recheck.md?"
even though `~/.claude/settings.json` already allowed `Write`, `Edit` and
`Write(//Users/yoavnatan/.claude/**)`, and the session was in `acceptEdits`.
Project files never prompted; only the memory directory did. It sits outside every
project root (`~/.claude/projects/<project>/memory/`, itself a symlink into the
project's `.claude-memory` backup repo — see [[reference_memory_backup]]), and
`acceptEdits` only auto-accepts inside the workspace. Why the absolute allow rule
did not cover it was never established.

**The fix is deterministic instead of diagnostic:**
`~/.claude/hooks/allow-claude-tree-writes.sh`, wired as a user-level `PreToolUse`
hook on `Write|Edit`. It returns `permissionDecision: "allow"` for any path under
`~/.claude/**` or `*/.claude-memory/**` (checking the literal path *and* its
symlink-resolved twin), and prints nothing for everything else — it never denies,
so ordinary files still go through the normal flow. A hook `allow` bypasses the
prompt outright, so no glob or symlink subtlety can reopen this.

`permissions.defaultMode: "acceptEdits"` was set in the same file, so a session
starts there instead of depending on a per-session toggle.

Settings changes need a session restart (or opening `/hooks`) to load — a live
session keeps the config it started with.
