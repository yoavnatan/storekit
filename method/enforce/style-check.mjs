#!/usr/bin/env node
// Checks the assistant's last reply against method/rules/communication.md and BLOCKS the turn when
// it breaks them.
//
// Why this exists, and why it is a blocker rather than a line in an instructions file: the owner
// spent this entire project repeating one request — shorter, plainer answers — and it never held.
// The rule was written in memory (`feedback_concise_summaries`) and in AI_INSTRUCTIONS, both of
// which are read at session start, and both of which lose to whatever the current turn feels like
// doing. In the same project, not one session ever ended on red code, because `require-green.sh`
// blocks it. That contrast IS the design principle of this whole folder: a rule with no enforcer is
// a preference, and preferences decay. So every rule in `rules/communication.md` that can be
// measured is measured here, and the ones that cannot are labelled unenforced in that file rather
// than pretended into effect.
//
// Bounded on purpose (MAX_BLOCKS). A gate with no escape hatch gets switched off, and then it
// protects nothing — the same reasoning as require-green.sh's two-strike bound. After the bound it
// prints the violations and lets the turn end.
//
// Usage:
//   Stop hook   — Claude Code pipes {transcript_path, session_id, ...} on stdin.
//   By hand     — `node style-check.mjs --file some.txt` or `... --text "..."` to try a rule out.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAX_CHARS = 900
const MAX_BLOCKS = 3
const MAX_BOLD = 1
const MAX_QUESTIONS = 1

// Latin words allowed in Hebrew prose without backticks: proper nouns and acronyms that have no
// Hebrew form. Anything else must be a real command or filename in backticks, or be said in Hebrew.
const ALLOWED_LATIN = new Set([
  'claude', 'anthropic', 'git', 'github', 'sql', 'api', 'url', 'css', 'html', 'json', 'seo',
  'payme', 'google', 'meta', 'node', 'npm', 'astro', 'vscode', 'render', 'cloudinary', 'postgres',
])

const SKELETON_OPENERS = [
  'קודם דבר אחד', 'קודם כל דבר', 'הנה החלוקה', 'הנה הפירוט', 'שלושה דברים', 'שני דברים',
  'מה שצריך להיבנות', 'הנקודה החשובה', 'הנקודה הקריטית', 'התשובה היא כן, אבל',
  'בוא נפרק', 'בוא נעשה סדר', 'יש כאן שתי שכבות', 'יש כאן שלוש',
]

const SELF_TALK = [
  'סליחה שהצפתי', 'סליחה, הצפתי', 'צודק, וזו התשובה', 'אתה צודק לגמרי', 'התנצלותי',
  'שים לב שאני', 'כפי שאמרתי קודם', 'כמו שכתבתי למעלה',
]

// ── input ───────────────────────────────────────────────────────────────────────────────────────

function readStdin() {
  try { return readFileSync(0, 'utf8') } catch { return '' }
}

function lastAssistantText(transcriptPath) {
  const raw = readFileSync(transcriptPath, 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    let row
    try { row = JSON.parse(lines[i]) } catch { continue }
    if (row.type !== 'assistant' || row.isSidechain) continue
    const content = row.message?.content
    if (!Array.isArray(content)) continue
    const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
    if (text) return { text, uuid: row.uuid || String(i) }
  }
  return null
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────────

/** Fenced code blocks are the assistant's work product, not its prose. Strip before measuring. */
function prose(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '')
}

/** Inline `code` spans hold real commands and filenames, which the latin-word rule must not flag. */
function withoutInlineCode(text) {
  return text.replace(/`[^`\n]*`/g, ' ')
}

export function check(text) {
  const v = []
  const p = prose(text).trim()
  const lines = p.split('\n')

  if (p.length > MAX_CHARS) {
    v.push(`אורך: ${p.length} תווים, המקסימום ${MAX_CHARS}. תקצר, אל תפצל לשתי הודעות.`)
  }

  const headers = lines.filter(l => /^\s{0,3}#{1,6}\s/.test(l))
  if (headers.length) v.push(`כותרות markdown (${headers.length}) — זו שיחה, לא מסמך.`)

  const boldLead = lines.filter(l => /^\s{0,3}\*\*/.test(l))
  if (boldLead.length) {
    v.push(`${boldLead.length} שורות פותחות בהדגשה — זה בונה מסמך. הראשונה: "${boldLead[0].slice(0, 40)}"`)
  }

  const boldCount = (p.match(/\*\*[^*\n]+\*\*/g) || []).length
  if (boldCount > MAX_BOLD) v.push(`${boldCount} הדגשות, מותרת ${MAX_BOLD}.`)

  const listLines = lines.filter(l => /^\s*([-*+]|\d+[.)])\s/.test(l))
  if (listLines.length) {
    v.push(`${listLines.length} שורות רשימה — הופכות כיוון בעברית. פסקאות קצרות במקום.`)
  }

  const bare = withoutInlineCode(p)
  const latin = [...new Set((bare.match(/[A-Za-z][A-Za-z.-]{2,}/g) || [])
    .map(w => w.replace(/[.-]+$/, ''))
    .filter(w => !ALLOWED_LATIN.has(w.toLowerCase())))]
  if (latin.length) {
    v.push(`מילים באנגלית בלי גרשיים אחוריים: ${latin.slice(0, 6).join(', ')}. או שם קובץ אמיתי, או בעברית.`)
  }

  const questions = (p.match(/\?/g) || []).length
  if (questions > MAX_QUESTIONS) v.push(`${questions} שאלות, מותרת ${MAX_QUESTIONS}.`)

  const opener = SKELETON_OPENERS.find(o => p.includes(o))
  if (opener) v.push(`פתיחת שלד: "${opener}" — תגיד את הדבר עצמו.`)

  const selfTalk = SELF_TALK.find(s => p.includes(s))
  if (selfTalk) v.push(`דיבור על עצמי: "${selfTalk}" — תקן והמשך.`)

  return v
}

// ── block counter (bounded, per session) ────────────────────────────────────────────────────────

function statePath(sessionId) {
  const dir = join(tmpdir(), 'claude-method-style')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, `${(sessionId || 'default').replace(/[^\w-]/g, '')}.json`)
}

function loadState(sessionId) {
  try { return JSON.parse(readFileSync(statePath(sessionId), 'utf8')) } catch { return { blocks: 0 } }
}

function saveState(sessionId, state) {
  try { writeFileSync(statePath(sessionId), JSON.stringify(state)) } catch { /* best effort */ }
}

// ── entry ───────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const fileArg = argv.indexOf('--file')
const textArg = argv.indexOf('--text')

if (fileArg !== -1 || textArg !== -1) {
  const text = fileArg !== -1 ? readFileSync(argv[fileArg + 1], 'utf8') : argv[textArg + 1]
  const v = check(text)
  if (!v.length) { console.log('style: ok') ; process.exit(0) }
  console.log(v.map(x => `• ${x}`).join('\n'))
  process.exit(1)
}

const payload = (() => { try { return JSON.parse(readStdin()) } catch { return {} } })()
const transcript = payload.transcript_path
if (!transcript || !existsSync(transcript)) process.exit(0)

const last = lastAssistantText(transcript)
if (!last) process.exit(0)

const rulesFile = join(HERE, '..', 'rules', 'communication.md')
const violations = check(last.text)
const state = loadState(payload.session_id)

if (!violations.length) {
  saveState(payload.session_id, { blocks: 0 })
  process.exit(0)
}

if (state.blocks >= MAX_BLOCKS) {
  saveState(payload.session_id, { blocks: 0 })
  console.error(`⚠️ הסגנון עדיין חורג אחרי ${MAX_BLOCKS} ניסיונות — עובר הלאה.\n` +
    violations.map(x => `• ${x}`).join('\n'))
  process.exit(0)
}

saveState(payload.session_id, { blocks: state.blocks + 1 })
console.error(
  `התשובה הזאת מפרה את ${rulesFile}. כתוב אותה מחדש — אותו תוכן, בלי המבנה:\n` +
  violations.map(x => `• ${x}`).join('\n') +
  `\n\nאל תתנצל ואל תסביר את התיקון. פשוט תענה שוב, קצר.`,
)
process.exit(2)
