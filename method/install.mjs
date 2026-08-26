#!/usr/bin/env node
// Installs this working method into another project.
//
//   node method/install.mjs /path/to/new-project
//
// Copies `method/` there, wires the style gate into that project's .claude/settings.json without
// touching any hook already configured, and writes the always-loaded user contract at
// ~/.claude/CLAUDE.md if it does not exist yet.
//
// What it deliberately does NOT do: copy this project's other hooks or its verify script. Those are
// coupled to this stack, and a checker written for one stack is not merely useless in another — it
// looks correct while checking nothing. They are carried as RULES (`rules/optimization.md`) for the
// next project to implement, not as files to paste.

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

// 1. the method folder itself
const methodDest = join(root, 'method')
if (resolve(methodDest) !== resolve(HERE)) {
  cpSync(HERE, methodDest, { recursive: true })
  done.push('method/ copied')
} else {
  done.push('method/ already here')
}

// 2. the style gate, merged into whatever hooks the project already has
const settingsPath = join(root, '.claude', 'settings.json')
mkdirSync(dirname(settingsPath), { recursive: true })

let settings = {}
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    console.error(`${settingsPath} is not valid JSON — fix it first, nothing was changed.`)
    process.exit(1)
  }
}

const COMMAND = 'node method/enforce/style-check.mjs'
settings.hooks ??= {}
settings.hooks.Stop ??= []

const already = JSON.stringify(settings.hooks.Stop).includes(COMMAND)
if (already) {
  done.push('style gate already wired')
} else {
  settings.hooks.Stop.push({
    hooks: [{
      type: 'command',
      command: COMMAND,
      timeout: 15,
      statusMessage: 'Checking the reply against method/rules/communication.md...',
    }],
  })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  done.push('style gate wired into .claude/settings.json')
}

// 3. the user-level contract — loaded in every folder on this machine, no invocation
const userClaude = join(homedir(), '.claude', 'CLAUDE.md')
if (existsSync(userClaude)) {
  done.push('~/.claude/CLAUDE.md exists — left alone')
} else {
  mkdirSync(dirname(userClaude), { recursive: true })
  cpSync(join(HERE, 'user-contract.md'), userClaude)
  done.push('~/.claude/CLAUDE.md written')
}

console.log(done.map(d => `  ${d}`).join('\n'))
console.log(`\nRead ${join(root, 'method', 'README.md')} for what happens next.`)
