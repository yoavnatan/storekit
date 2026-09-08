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

// ── The sentence shape he named twice on 2026-09-07, quoting two of my own lines back ──
//
//   "והחולשה האמיתית, שקיימת בשני המודלים: הערך שלך למוכר הוא תנועה, ואין לך תנועה ביום הראשון."
//   "זה שיקול לגיטימי, והוא גם קובע סדר נכון: קודם הגרסה שלא עולה כלום, ואחר כך ... החלטה מול
//    נתונים ולא מול תקווה."
//
// His words: *"איך שאתה מרכיב משפט, איך שאתה מסביר לוגיקה, זה כאילו אתה עוטף הכל באיזה זיוף הגיוני
// כזה"* — and then, an hour later, *"אני שונא גם את הסגנון הזה שלך"* about the second one. Ordinary
// reasoning dressed as a maxim, which is exactly the dressing he cannot check.
//
// Three habits, each detectable on its own, and a note names the one it found rather than the class.

/** Announcing a fact's importance before saying it. He decides what is important. */
const IMPORTANCE_LABELS = [
  'החולשה האמיתית', 'הבעיה האמיתית', 'השאלה האמיתית', 'הסיבה האמיתית', 'מה שבאמת',
  'הדבר החשוב', 'הנקודה האמיתית', 'העיקר הוא', 'מה שחשוב באמת', 'האמת היא ש',
  'וזה הדבר החשוב', 'הדבר המשמעותי', 'מה שקובע באמת',
]

/** Ratifying his own decision back to him before answering it. */
const RATIFYING_OPENERS = [
  'זה שיקול לגיטימי', 'שיקול לגיטימי', 'זו החלטה נכונה', 'ההחלטה שלך נכונה', 'זה הגיוני לגמרי',
  'אתה צודק לחלוטין', 'וזה בדיוק הסדר הנכון', 'זה בדיוק הסדר הנכון',
]

/**
 * A sentence that ends on a BALANCED contrast — "…החלטה מול נתונים ולא מול תקווה." — which is the
 * flourish that turns a fact into a slogan.
 *
 * The discriminator is the repeated word, and it was found by watching the first version fail: a
 * plain tail match flagged "שמור את הטוקן בקובץ ולא בקוד שרץ", which is an instruction and not a
 * slogan. What makes the slogan version a slogan is the mirroring — the same word on both sides of
 * the ולא, so the two halves scan alike. A note that fires on ordinary sentences gets ignored, and
 * then it guards nothing.
 */
const CONTRAST_TAIL = /(\S{2,})\s+\S+\s+(?:ולא|אלא)\s+\1\s+\S+\s*[.!]/

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

/**
 * Two severities, and the split is the whole point of this file's second version.
 *
 * A Stop hook cannot un-send. By the time it runs, the owner has already read the reply — so
 * blocking makes him read a SECOND, nearly identical one. He noticed within an hour of this being
 * installed and it was the same complaint that caused the file to exist: "why are you answering me
 * twice?" A duplicate message costs him more attention than a stiff sentence does.
 *
 * So: BLOCK only where the reply is genuinely unusable as it stands — it is too long to read, or it
 * is shaped like a document instead of an answer. Everything else is a NOTE: printed to the model,
 * never resent, and it lands before the next reply is written, which is where a wording fix belongs
 * anyway. The notes are not decoration — they are the only channel that improves the NEXT message
 * instead of duplicating this one.
 */
export function check(text) {
  const block = []
  const note = []
  const p = prose(text).trim()
  const lines = p.split('\n')

  if (p.length > MAX_CHARS) {
    block.push(`אורך: ${p.length} תווים, המקסימום ${MAX_CHARS}. תקצר, אל תפצל לשתי הודעות.`)
  }

  const headers = lines.filter(l => /^\s{0,3}#{1,6}\s/.test(l))
  if (headers.length) block.push(`כותרות markdown (${headers.length}) — זו שיחה, לא מסמך.`)

  // `-`, `*`, `+` and `1.` are MARKDOWN list syntax: the renderer builds a `<ul>`, which lays the
  // marker out left-to-right and flips the Hebrew line with it. A literal `•` is not syntax — it is
  // a neutral character that takes the paragraph's own direction, so it sits on the RIGHT and the
  // line reads normally. The owner asked for structured lines on 2026-09-08 ("זה לא נוח ככה") and
  // this is the shape that gives them without the thing the rule was protecting against. Verify in
  // a real terminal before widening this again — the original ban came from seeing it break.
  const listLines = lines.filter(l => /^\s*([-*+]|\d+[.)])\s/.test(l))
  if (listLines.length) {
    block.push(`${listLines.length} שורות רשימה עם ${'`-`'} או ${'`1.`'} — markdown הופך אותן LTR. פתח את השורה ב-• במקום.`)
  }

  const boldLead = lines.filter(l => /^\s{0,3}\*\*/.test(l))
  if (boldLead.length > 1) {
    block.push(`${boldLead.length} שורות פותחות בהדגשה — זה מסמך. הראשונה: "${boldLead[0].slice(0, 40)}"`)
  } else if (boldLead.length) {
    note.push('שורה שפותחת בהדגשה בונה מסמך — תגיד את הדבר במשפט.')
  }

  const boldCount = (p.match(/\*\*[^*\n]+\*\*/g) || []).length
  if (boldCount > MAX_BOLD) note.push(`${boldCount} הדגשות, מותרת ${MAX_BOLD}.`)

  const bare = withoutInlineCode(p)
  const latin = [...new Set((bare.match(/[A-Za-z][A-Za-z.-]{2,}/g) || [])
    .map(w => w.replace(/[.-]+$/, ''))
    .filter(w => !ALLOWED_LATIN.has(w.toLowerCase())))]
  if (latin.length) {
    note.push(`מילים באנגלית בלי גרשיים אחוריים: ${latin.slice(0, 6).join(', ')}.`)
  }

  const questions = (p.match(/\?/g) || []).length
  if (questions > MAX_QUESTIONS) note.push(`${questions} שאלות, מותרת ${MAX_QUESTIONS}.`)

  const opener = SKELETON_OPENERS.find(o => p.includes(o))
  if (opener) note.push(`פתיחת שלד: "${opener}" — תגיד את הדבר עצמו.`)

  const selfTalk = SELF_TALK.find(s => p.includes(s))
  if (selfTalk) note.push(`דיבור על עצמי: "${selfTalk}".`)

  const label = IMPORTANCE_LABELS.find(l => p.includes(l))
  if (label) note.push(`"${label}" מכריז שמשהו חשוב במקום להגיד אותו. תוריד את ההכרזה.`)

  const ratify = RATIFYING_OPENERS.find(r => p.includes(r))
  if (ratify) note.push(`"${ratify}" מאשר לו את ההחלטה שלו במקום לענות עליה.`)

  const contrast = p.match(CONTRAST_TAIL)
  if (contrast) {
    note.push(`משפט שנסגר על ניגוד: "${contrast[0].trim().slice(-50)}" — תגיד את זה בשני משפטים.`)
  }

  return { block, note }
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
  const { block, note } = check(text)
  if (note.length) console.log(note.map(x => `note: ${x}`).join('\n'))
  if (!block.length) { console.log('style: ok'); process.exit(0) }
  console.log(block.map(x => `• ${x}`).join('\n'))
  process.exit(1)
}

const payload = (() => { try { return JSON.parse(readStdin()) } catch { return {} } })()
const transcript = payload.transcript_path
if (!transcript || !existsSync(transcript)) process.exit(0)

const last = lastAssistantText(transcript)
if (!last) process.exit(0)

const rulesFile = join(HERE, '..', 'rules', 'communication.md')
const { block, note } = check(last.text)
const state = loadState(payload.session_id)

// Notes ride along on whatever this hook decides. They reach the model without costing the owner a
// second message, so they are printed on the pass path too — that is the point of them existing.
const noteText = note.length
  ? `\nלפעם הבאה, בלי לענות שוב:\n${note.map(x => `• ${x}`).join('\n')}`
  : ''

if (!block.length) {
  saveState(payload.session_id, { blocks: 0 })
  if (noteText) console.error(noteText.trim())
  process.exit(0)
}

if (state.blocks >= MAX_BLOCKS) {
  saveState(payload.session_id, { blocks: 0 })
  console.error(`⚠️ הסגנון עדיין חורג אחרי ${MAX_BLOCKS} ניסיונות — עובר הלאה.\n` +
    block.map(x => `• ${x}`).join('\n') + noteText)
  process.exit(0)
}

saveState(payload.session_id, { blocks: state.blocks + 1 })
console.error(
  `התשובה הזאת מפרה את ${rulesFile}, והוא כבר ראה אותה — התשובה הבאה תיראה לו כהודעה שנייה.\n` +
  `אז כתוב משהו קצר שעומד בפני עצמו, לא ניסוח מחדש של אותו טקסט:\n` +
  block.map(x => `• ${x}`).join('\n') + noteText +
  `\n\nאל תתנצל ואל תסביר את התיקון.`,
)
process.exit(2)
