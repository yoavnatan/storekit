#!/usr/bin/env node
// The one command that runs a project's checks. Stack-agnostic: it runs whatever
// `method/checks.json` declares, so the same file works for TypeScript, Python, Go, Rust or a
// language nobody has invented yet. Only the declarations change.
//
// Three things make it worth having instead of running the tools by hand, and all three are why
// `rules/optimization.md` insists there be exactly ONE way to run them:
//   • Concurrency — the checks are independent read-only passes, so the cost is the slowest, not
//     the sum.
//   • A fingerprint cache — a check whose inputs are byte-identical to the last time it passed is
//     skipped. A turn that changed no code costs milliseconds instead of the whole suite.
//   • Named skips — every check that did NOT run is printed. A silent skip is how a green result
//     starts lying.
//
// `--all` disables the cache and runs everything. That is what the Stop hook uses, because a check
// skipped for a file committed earlier in the session is still a check that did not run.
//
//   node method/enforce/verify.mjs            # cached, skips unchanged checks
//   node method/enforce/verify.mjs --all      # everything, no cache
//   node method/enforce/verify.mjs --no-cache

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const CHECKS_FILE = join(ROOT, 'method', 'checks.json')
const CACHE_FILE = join(ROOT, 'method', '.verify-cache.json')

const args = process.argv.slice(2)
const all = args.includes('--all')
const noCache = all || args.includes('--no-cache')

if (!existsSync(CHECKS_FILE)) {
  console.log('verify: method/checks.json does not exist — nothing to run.')
  console.log('        Add checks there, or re-run `node method/install.mjs .` to detect the stack.')
  process.exit(0)
}

const checks = JSON.parse(readFileSync(CHECKS_FILE, 'utf8')).checks || []
if (!checks.length) {
  console.log('verify: no checks declared in method/checks.json.')
  console.log('        A project with no gate has no green — declare at least a test command.')
  process.exit(0)
}

// ── fingerprints ────────────────────────────────────────────────────────────────────────────────
// Content hash, not mtime: a fresh checkout or a worktree setup rewrites every mtime while changing
// no code, and a cache that invalidates on that is a cache nobody benefits from.

function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    return out.split('\n').filter(Boolean)
  } catch {
    return [] // not a git repo yet: every check simply runs uncached
  }
}

/**
 * Turns a glob into a matcher. Deliberately tiny — `**` spans directories, `*` stays inside one
 * segment, `?` is one character. Anything more elaborate belongs in the check command itself.
 */
function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; out += '(?:[^/]+/)*' } else { out += '.*' }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp(`^${out}$`)
}

const FILES = trackedFiles()
const unmatched = []

function fingerprint(check) {
  const patterns = (check.inputs || []).map(globToRegExp)
  if (!patterns.length || !FILES.length) return null // no declared inputs → never cached
  const matched = FILES.filter(f => patterns.some(re => re.test(f))).sort()
  // Zero matches means the globs do not describe this project's files — an extension the detection
  // missed, a renamed directory. Caching on that fingerprint is the worst failure this file has:
  // it reports GREEN on code it never looked at. Caught exactly that way on 2026-08-26, when a
  // node project's `.mjs` sources matched none of the declared `**/*.js` globs and a deliberately
  // broken function still verified green. No matches → never cached, and say so.
  if (!matched.length) {
    unmatched.push(check.name)
    return null
  }
  const h = createHash('sha256')
  h.update(check.command)
  for (const f of matched) {
    const abs = join(ROOT, f)
    try {
      if (!statSync(abs).isFile()) continue
      h.update(f)
      h.update(readFileSync(abs))
    } catch { /* deleted between listing and reading — the next run sees it */ }
  }
  return h.digest('hex')
}

function loadCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) } catch { return {} }
}

function saveCache(cache) {
  try { writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n') } catch { /* best effort */ }
}

// ── running ─────────────────────────────────────────────────────────────────────────────────────

function run(check) {
  return new Promise(resolve => {
    const started = Date.now()
    execFile(check.command, {
      cwd: ROOT,
      shell: true,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, METHOD_VERIFY: '1' },
    }, (err, stdout, stderr) => {
      resolve({
        name: check.name,
        ok: !err,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        output: `${stdout || ''}${stderr || ''}`.trim(),
      })
    })
  })
}

const cache = noCache ? {} : loadCache()
const toRun = []
const skipped = []

for (const check of checks) {
  const fp = fingerprint(check)
  if (!noCache && fp && cache[check.name] === fp) skipped.push(check.name)
  else toRun.push({ check, fp })
}

if (!toRun.length) {
  console.log('verify: green — nothing to re-run')
  console.log(`        unchanged since it last passed: ${skipped.join(', ')} — \`--no-cache\` re-runs them.`)
  process.exit(0)
}

const results = await Promise.all(toRun.map(({ check }) => run(check)))

const nextCache = loadCache()
for (const { check, fp } of toRun) {
  const result = results.find(r => r.name === check.name)
  if (result?.ok && fp) nextCache[check.name] = fp
  else delete nextCache[check.name]
}
saveCache(nextCache)

const failed = results.filter(r => !r.ok)
const passed = results.filter(r => r.ok)

for (const f of failed) {
  console.log(`\n--- ${f.name} ---`)
  console.log(f.output || '(no output)')
}

const timings = passed.map(r => `${r.name} ${r.seconds}s`).join(' · ')

function reportSkips() {
  if (skipped.length) console.log(`        not run (unchanged): ${skipped.join(', ')}`)
  if (unmatched.length) {
    console.log(`⚠️  inputs match no files, so these can never be cached: ${unmatched.join(', ')}`)
    console.log('    Fix the globs in method/checks.json — they do not describe this project.')
  }
}

if (failed.length) {
  console.log(`\nverify: RED — ${failed.map(f => f.name).join(', ')}`)
  if (timings) console.log(`        green: ${timings}`)
  reportSkips()
  process.exit(1)
}

console.log(`verify: green — ${timings}`)
reportSkips()
