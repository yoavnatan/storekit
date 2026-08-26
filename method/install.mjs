#!/usr/bin/env node
// Installs this working method into a project — an existing one, or an empty folder about to become
// one.
//
//   node method/install.mjs /path/to/project
//
// It copies `method/`, scaffolds the three files a session reads (CLAUDE.md, AI_INSTRUCTIONS.md,
// CURRENT_TASK.md), detects the stack and writes `method/checks.json` for it, wires the three gates
// into `.claude/settings.json` without touching hooks already configured, and writes
// `~/.claude/CLAUDE.md` if it is missing.
//
// Everything it writes, it writes ONLY if absent. Re-running it on a live project adds what is
// missing and changes nothing that exists — so it is safe to run again after adding a language.
//
// What it deliberately does not do: guess the project's purpose. That is `kickoff.md`'s job, and it
// belongs to a conversation, not a script.

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2]

if (!target) {
  console.error('usage: node method/install.mjs /path/to/project')
  process.exit(1)
}

const root = resolve(target)
if (!existsSync(root)) {
  console.error(`no such directory: ${root}`)
  process.exit(1)
}

const done = []
const has = p => existsSync(join(root, p))
const read = p => readFileSync(join(root, p), 'utf8')

function writeIfAbsent(rel, contents, label) {
  if (has(rel)) { done.push(`${rel} exists — left alone`); return false }
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), contents)
  done.push(label || `${rel} written`)
  return true
}

// ── 1. the method folder ────────────────────────────────────────────────────────────────────────

const methodDest = join(root, 'method')
if (resolve(methodDest) !== resolve(HERE)) {
  cpSync(HERE, methodDest, { recursive: true, filter: src => !src.endsWith('.verify-cache.json') })
  done.push('method/ copied')
} else {
  done.push('method/ already here')
}

// ── 2. stack detection → method/checks.json ─────────────────────────────────────────────────────
// Each entry: what the check is called, the command, and the globs whose contents decide whether it
// can be skipped. Guessed conservatively — a wrong command is obvious on the first run, a missing
// check is not.

function detectChecks() {
  if (has('package.json')) {
    let pkg = {}
    try { pkg = JSON.parse(read('package.json')) } catch { /* malformed — fall through to defaults */ }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const scripts = pkg.scripts || {}
    const checks = []
    if (deps.typescript || has('tsconfig.json')) {
      checks.push({ name: 'types', command: 'npx tsc --noEmit', inputs: ['**/*.ts', '**/*.tsx', 'tsconfig.json'] })
    }
    if (scripts.lint) {
      checks.push({ name: 'lint', command: 'npm run lint', inputs: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', 'eslint.config.*', '.eslintrc*'] })
    }
    if (scripts.test) {
      checks.push({ name: 'test', command: 'npm test', inputs: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'] })
    }
    return { stack: 'node', checks }
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    return {
      stack: 'python',
      checks: [
        { name: 'lint', command: 'ruff check .', inputs: ['**/*.py', 'pyproject.toml'] },
        { name: 'types', command: 'mypy .', inputs: ['**/*.py', 'pyproject.toml'] },
        { name: 'test', command: 'pytest -q', inputs: ['**/*.py'] },
      ],
    }
  }
  if (has('go.mod')) {
    return {
      stack: 'go',
      checks: [
        { name: 'vet', command: 'go vet ./...', inputs: ['**/*.go', 'go.mod'] },
        { name: 'test', command: 'go test ./...', inputs: ['**/*.go', 'go.mod'] },
      ],
    }
  }
  if (has('Cargo.toml')) {
    return {
      stack: 'rust',
      checks: [
        { name: 'clippy', command: 'cargo clippy -- -D warnings', inputs: ['**/*.rs', 'Cargo.toml'] },
        { name: 'test', command: 'cargo test', inputs: ['**/*.rs', 'Cargo.toml'] },
      ],
    }
  }
  return { stack: 'unknown', checks: [] }
}

const detected = detectChecks()
const checksJson = JSON.stringify({
  stack: detected.stack,
  note: 'Declared checks. `name` is what verify prints, `command` is what runs, `inputs` are the ' +
        'globs whose CONTENTS decide whether the check can be skipped when nothing changed. ' +
        'A check with no inputs never gets cached. Prove each one can FAIL before trusting it.',
  checks: detected.checks,
}, null, 2) + '\n'

if (writeIfAbsent('method/checks.json', checksJson,
  detected.checks.length
    ? `method/checks.json written — ${detected.stack}: ${detected.checks.map(c => c.name).join(', ')}`
    : 'method/checks.json written — EMPTY, no stack detected; declare the checks by hand')) { /* noted */ }

// ── 3. the three files a session reads ──────────────────────────────────────────────────────────

writeIfAbsent('CLAUDE.md', `# CLAUDE.md

Read \`AI_INSTRUCTIONS.md\` and \`CURRENT_TASK.md\` before doing anything.

If \`CURRENT_TASK.md\` has no instruction in it yet, this project has not been started — read
\`method/kickoff.md\` and follow it.

How this project is worked on lives in \`method/\`. The rules there are enforced by hooks in
\`.claude/settings.json\`, not by being remembered: replies are checked against
\`method/rules/communication.md\`, the turn cannot end while \`node method/enforce/verify.mjs --all\`
is red, and those checks run through that one command only.

Nothing else belongs in this file. It exists to be read when nothing else has been.
`)

writeIfAbsent('CURRENT_TASK.md', `# Current task

This file belongs to the owner. Claude reads it and never writes to \`Your instruction\`.

## Your instruction

_(empty — the project has not been started yet. Say what you want built.)_
`)

writeIfAbsent('AI_INSTRUCTIONS.md', `# AI Instructions

Read this and \`CURRENT_TASK.md\` at the start of every session.

## What we're building

_(one paragraph — what it is, who uses it. Written at kickoff from the owner's answers.)_

## Where it runs

_(his machine, a server, a browser, a phone. This decides more than the stack does.)_

## Decided — do not re-open without saying so

_(every settled decision, with its date. This section is why the same argument does not happen
three times. Add to it; never quietly reverse it.)_

## Hard rules

_(project-specific rules only. The ones that are not project-specific already live in \`method/rules/\`
and are enforced.)_

## Workflow

1. Read this file and \`CURRENT_TASK.md\`.
2. Do only what \`CURRENT_TASK.md → Your instruction\` says.
3. Before calling anything done: \`node method/enforce/verify.mjs --all\` green, and the diff checked
   against \`method/rules/bug-classes.md\`.
4. A second session opens its own worktree — \`method/rules/parallel.md\`.
5. At the end of a session, anything learned that would be lost goes where
   \`method/rules/accrual.md\` says it goes.

## Features built

_(one line per feature, added as they land. Names and gotchas, never implementation detail.)_

## Project structure

_(one line per file: \`path ← what it is\`. This is what stops the next session re-exploring.)_
`)

// ── 4. the gates ────────────────────────────────────────────────────────────────────────────────

const settingsPath = join(root, '.claude', 'settings.json')
mkdirSync(dirname(settingsPath), { recursive: true })

let settings = {}
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    console.error(`${settingsPath} is not valid JSON — fix it first. Nothing else was changed.`)
    process.exit(1)
  }
}

settings.hooks ??= {}

function wire(event, command, statusMessage, matcher) {
  settings.hooks[event] ??= []
  if (JSON.stringify(settings.hooks[event]).includes(command)) {
    done.push(`${event} gate already wired`)
    return
  }
  const group = { hooks: [{ type: 'command', command, timeout: 420, statusMessage }] }
  if (matcher) group.matcher = matcher
  settings.hooks[event].push(group)
  done.push(`${event} gate wired — ${command}`)
}

wire('Stop', 'node method/enforce/style-check.mjs',
  'Checking the reply against method/rules/communication.md...')
wire('Stop', 'node method/enforce/require-green.mjs',
  'Running the checks — the turn cannot end on red...')
wire('PreToolUse', 'node method/enforce/one-way-to-verify.mjs',
  'Checking the one-command rule...', 'Bash')

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')

// ── 5. the always-loaded contract ───────────────────────────────────────────────────────────────

const userClaude = join(homedir(), '.claude', 'CLAUDE.md')
if (existsSync(userClaude)) {
  done.push('~/.claude/CLAUDE.md exists — left alone')
} else {
  mkdirSync(dirname(userClaude), { recursive: true })
  cpSync(join(HERE, 'user-contract.md'), userClaude)
  done.push('~/.claude/CLAUDE.md written')
}

// ── 6. gitignore the cache ──────────────────────────────────────────────────────────────────────

const ignoreLine = 'method/.verify-cache.json'
const gitignore = join(root, '.gitignore')
const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : ''
if (!existing.includes(ignoreLine)) {
  writeFileSync(gitignore, `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}${ignoreLine}\n`)
  done.push('.gitignore updated')
}

console.log(done.map(d => `  ${d}`).join('\n'))
console.log(`\nNext: node method/enforce/verify.mjs --all`)
if (!detected.checks.length) {
  console.log('⚠️  No checks were detected. Until method/checks.json declares at least one, the green')
  console.log('    gate has nothing to enforce and the project has no gate at all.')
}
