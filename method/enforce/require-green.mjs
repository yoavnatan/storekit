#!/usr/bin/env node
// Stop hook — the turn does not end on red.
//
// This is the single most important file in `method/`. Everything else here is a rule that can be
// forgotten; this one cannot be, because it does not rely on anybody remembering it. In the project
// this method came from, every written-only rule was broken repeatedly over a month, and not one
// session ever ended on failing code.
//
// Two costs are managed rather than ignored:
//   • Running the checks is delegated to verify.mjs, which runs them concurrently.
//   • Re-running them when nothing changed is waste, so a green result is recorded against a content
//     fingerprint. A turn that changed no code exits in milliseconds.
//
// Bounded at MAX_BLOCKS per fingerprint, then it warns and lets the turn end. A gate with no escape
// hatch gets switched off by the person it annoys, and then it protects nothing.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const MAX_BLOCKS = 2

try { readFileSync(0, 'utf8') } catch { /* drain the hook payload; nothing here needs it */ }

if (!existsSync(join(ROOT, 'method', 'checks.json'))) process.exit(0)

/** What the working tree looks like right now — the key the block counter is stored against. */
function diffFingerprint() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
    const diff = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    const patch = execFileSync('git', ['diff', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    return createHash('sha256').update(head + diff + patch).digest('hex').slice(0, 16)
  } catch {
    return 'no-git'
  }
}

function statePath(fp) {
  const dir = join(tmpdir(), 'claude-method-green')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `${fp}.json`)
}

function blocksSoFar(fp) {
  try { return JSON.parse(readFileSync(statePath(fp), 'utf8')).blocks || 0 } catch { return 0 }
}

function recordBlock(fp, blocks) {
  try { writeFileSync(statePath(fp), JSON.stringify({ blocks })) } catch { /* best effort */ }
}

let output
let green = true
try {
  output = execFileSync('node', [join(ROOT, 'method', 'enforce', 'verify.mjs'), '--all'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
} catch (err) {
  green = false
  output = `${err.stdout || ''}${err.stderr || ''}`.trim() || String(err)
}

if (green) process.exit(0)

const fp = diffFingerprint()
const blocks = blocksSoFar(fp)

if (blocks >= MAX_BLOCKS) {
  console.error(
    `⚠️ Checks are still failing after ${MAX_BLOCKS} blocks — letting the turn end.\n` +
    `Say plainly in the summary that the tree is RED and what is failing.\n\n${output}`,
  )
  process.exit(0)
}

recordBlock(fp, blocks + 1)
console.error(
  `The checks are failing. Fix them before ending the turn — do not report this as done.\n\n${output}`,
)
process.exit(2)
