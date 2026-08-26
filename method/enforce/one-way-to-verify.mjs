#!/usr/bin/env node
// PreToolUse(Bash) — the declared checks run through verify.mjs, and nowhere else.
//
// Why block rather than document it. Running `pytest` or `tsc` by hand gets a slower, narrower
// answer, and the session then believes it: no cache, no concurrency, no list of what was skipped.
// In the project this came from, the instruction "never run these by hand" sat in the always-read
// rules for a week and was broken in most sessions until a hook stopped it.
//
// It reads method/checks.json, so it blocks whatever THIS project's checks are — no hardcoded tool
// names. A check command that is genuinely needed on its own (iterating on one failing test file)
// stays allowed: only a bare invocation of a whole declared check is refused.

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const CHECKS = join(ROOT, 'method', 'checks.json')

let payload = {}
try { payload = JSON.parse(readFileSync(0, 'utf8')) } catch { process.exit(0) }

const command = (payload.tool_input?.command || '').trim()
if (!command || !existsSync(CHECKS)) process.exit(0)

// Already going through the one command, or explicitly asking for the escape hatch.
if (/method\/enforce\/verify\.mjs|METHOD_VERIFY/.test(command)) process.exit(0)

const checks = JSON.parse(readFileSync(CHECKS, 'utf8')).checks || []

for (const check of checks) {
  const bare = check.command.trim()
  if (!bare) continue
  // The whole check, run on its own: same command, no extra arguments narrowing it to one file.
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`(^|[;&|]\\s*)${escaped}\\s*($|[;&|])`).test(command)) {
    console.error(
      `\`${bare}\` is the "${check.name}" check. Run \`node method/enforce/verify.mjs\` instead — ` +
      `it runs every check concurrently, skips the ones whose inputs did not change, and names ` +
      `what it did not run. Narrowing it to a single file or test while iterating is still fine.`,
    )
    process.exit(2)
  }
}

process.exit(0)
