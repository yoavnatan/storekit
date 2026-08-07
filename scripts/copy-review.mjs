// A round-trip for reviewing the Hebrew copy without editing source.
//
// `export` flattens the `he:` block of src/i18n/translations.ts into a plain text file — one key
// per stanza, the Hebrew alone on its own line, the English underneath as a reference. `apply`
// reads that file back, writes only the lines that actually changed into translations.ts, and
// prints the changed keys so the English can be re-phrased to match.
//
// Why a file and not "just edit translations.ts": the source interleaves 1200 strings with
// comments, nesting and two languages 1300 lines apart, and RTL text mixed into a line of Latin
// syntax is genuinely hard to read. It also means the review can be sliced by section — the
// copy for one screen at a time — instead of all of it at once.
//
// The apply direction never reformats the file. It replaces the exact character range of each
// changed string literal and leaves everything else — comments, ordering, spacing — untouched,
// so `git diff` after a review shows the copy changes and nothing else.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'src/i18n/translations.ts');
// Dot-prefixed and `.tmp-`: both already covered by .gitignore, so a review in progress can never
// be committed by accident and no ignore rule has to be added for it.
const REVIEW_FILE = path.join(ROOT, '.tmp-copy-review.txt');

// --- reading translations.ts -------------------------------------------------------------------

// Returns the index just past a `//` or `/* */` comment starting at `i`, or -1 if there is none.
function skipComment(src, i) {
  if (src[i] !== '/') return -1;
  if (src[i + 1] === '/') {
    const end = src.indexOf('\n', i);
    return end === -1 ? src.length : end;
  }
  if (src[i + 1] === '*') return src.indexOf('*/', i) + 2;
  return -1;
}

// Returns the index just past the string literal opening at `i`.
function skipString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
  return j + 1;
}

// Reads `identifier:` at `i` and returns [identifier, indexPastColon] — or [null, indexPastWord]
// when no colon follows, i.e. a bare word inside an expression rather than a key.
function readKey(src, i) {
  let j = i;
  while (j < src.length && /[\w$]/.test(src[j])) j++;
  let k = j;
  while (/\s/.test(src[k])) k++;
  return src[k] === ':' ? [src.slice(i, j), k + 1] : [null, j];
}

// Walks one language block and returns every string leaf with the exact source range of its
// literal. A regex per line cannot do this: the block holds comments (some containing quotes and
// braces), nested objects, and an array of objects whose keys repeat per element.
function scanLanguageBlock(src, lang) {
  const header = new RegExp(`^\\s*${lang}:\\s*\\{`, 'm');
  const headerMatch = header.exec(src);
  if (!headerMatch) throw new Error(`No \`${lang}:\` block found in ${path.relative(ROOT, SOURCE)}`);

  let i = src.indexOf('{', headerMatch.index);
  const leaves = [];
  const stack = [];
  const segments = [];
  let pendingKey = null;

  // In an array the position is the key; in an object it is whatever identifier preceded the colon.
  const takeSegment = () => {
    const top = stack[stack.length - 1];
    if (top && top.type === 'array') return String(top.index++);
    const key = pendingKey;
    pendingKey = null;
    return key;
  };

  while (i < src.length) {
    const c = src[i];

    const afterComment = skipComment(src, i);
    if (afterComment !== -1) {
      i = afterComment;
      continue;
    }

    if (c === '{' || c === '[') {
      const segment = stack.length ? takeSegment() : null;
      if (segment !== null) segments.push(segment);
      stack.push(c === '{' ? { type: 'object' } : { type: 'array', index: 0 });
      i++;
      continue;
    }

    if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length) segments.pop();
      i++;
      if (!stack.length) break; // end of the language block
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      i = skipString(src, i);
      const segment = takeSegment();
      if (segment !== null) {
        leaves.push({
          key: [...segments, segment].join('.'),
          start,
          end: i,
          value: unescapeLiteral(src.slice(start + 1, i - 1)),
        });
      }
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      const [identifier, next] = readKey(src, i);
      if (identifier) pendingKey = identifier;
      i = next;
      continue;
    }

    i++;
  }

  return leaves;
}

function unescapeLiteral(raw) {
  return raw.replace(/\\(.)/g, (_, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
}

function escapeLiteral(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

// --- export ------------------------------------------------------------------------------------

function runExport(requestedSections) {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const hebrew = scanLanguageBlock(src, 'he');
  const english = new Map(scanLanguageBlock(src, 'en').map((leaf) => [leaf.key, leaf.value]));

  const allSections = [...new Set(hebrew.map((leaf) => leaf.key.split('.')[0]))];
  const unknown = requestedSections.filter((s) => !allSections.includes(s));
  if (unknown.length) {
    console.error(`\nUnknown section(s): ${unknown.join(', ')}`);
    console.error(`Available: ${allSections.join(', ')}\n`);
    process.exit(1);
  }

  const sections = requestedSections.length ? requestedSections : allSections;
  const selected = hebrew.filter((leaf) => sections.includes(leaf.key.split('.')[0]));

  const lines = [
    '# Hebrew copy review.',
    '#',
    '# Edit ONLY the Hebrew line directly under each [key]. Everything else is context:',
    '# the `en:` line is the current English and is regenerated from the Hebrew afterwards,',
    '# so there is no point editing it here.',
    '#',
    '# Do not add, remove or reorder [key] stanzas — apply matches them by key.',
    '# A literal line break inside a string is written as \\n.',
    '#',
    `# ${selected.length} strings, sections: ${sections.join(', ')}`,
    '#',
    '# When done:  npm run copy:apply',
    '',
  ];

  let currentSection = null;
  for (const leaf of selected) {
    const section = leaf.key.split('.')[0];
    if (section !== currentSection) {
      currentSection = section;
      lines.push(`## ${section}`, '');
    }
    lines.push(`[${leaf.key}]`);
    lines.push(leaf.value.replace(/\n/g, '\\n'));
    lines.push(`  en: ${(english.get(leaf.key) ?? '').replace(/\n/g, '\\n')}`);
    lines.push('');
  }

  fs.writeFileSync(REVIEW_FILE, lines.join('\n'), 'utf8');
  console.log(`\n${selected.length} strings written to ${path.relative(ROOT, REVIEW_FILE)}`);
  console.log(`Sections: ${sections.join(', ')}`);
  console.log('\nEdit the Hebrew lines, then run:  npm run copy:apply\n');
}

// --- apply -------------------------------------------------------------------------------------

function parseReviewFile() {
  const text = fs.readFileSync(REVIEW_FILE, 'utf8');
  const lines = text.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^\[([^\]]+)\]$/.exec(lines[i]);
    if (!match) continue;
    // The value is whatever sits on the very next line, taken verbatim — no pattern matching, so a
    // Hebrew string that happens to start with `#` or `[` still round-trips.
    entries.push({ key: match[1], value: (lines[i + 1] ?? '').replace(/\\n/g, '\n'), line: i + 2 });
    i++;
  }
  // The header count, so a stanza that was deleted or joined into its neighbour is caught. Without
  // it the parser simply never sees that key and the edit under it is dropped in silence — the one
  // failure mode of this format where a reviewer's work disappears with nothing on screen.
  const declared = /^# (\d+) strings,/m.exec(text);
  return { entries, declared: declared ? Number(declared[1]) : null };
}

function runApply() {
  if (!fs.existsSync(REVIEW_FILE)) {
    console.error(`\nNo review file at ${path.relative(ROOT, REVIEW_FILE)} — run \`npm run copy:review\` first.\n`);
    process.exit(1);
  }

  const src = fs.readFileSync(SOURCE, 'utf8');
  const leaves = new Map(scanLanguageBlock(src, 'he').map((leaf) => [leaf.key, leaf]));
  const { entries, declared } = parseReviewFile();

  if (declared !== null && declared !== entries.length) {
    console.error(`\nRefusing to apply — the review file was exported with ${declared} strings but ${entries.length} were found.`);
    console.error('A [key] line was deleted or joined to the line above it, and every edit under a');
    console.error('missing [key] would be dropped without a word. Re-export and redo, or restore the line.\n');
    process.exit(1);
  }

  const missing = entries.filter((e) => !leaves.has(e.key));
  if (missing.length) {
    console.error(`\nRefusing to apply — ${missing.length} key(s) in the review file no longer exist:`);
    for (const e of missing.slice(0, 10)) console.error(`  · ${e.key} (line ${e.line - 1})`);
    console.error('\nRe-export and redo those, or fix the key names.\n');
    process.exit(1);
  }

  // Damage is judged on the text exactly as it was typed, BEFORE any tidying: trimming a line that
  // reads `  en: Home` would turn it into a plausible-looking value and walk it straight past the
  // check that exists to catch it.
  const proposed = entries.map((e) => ({ ...e, leaf: leaves.get(e.key) }));
  refuseOnDamage(proposed.filter((c) => c.value !== c.leaf.value));

  // What survives is a wording change with hand-editing marks on it: a stray space where a word was
  // deleted, two spaces where a line was joined. Tidied rather than refused — but always named, so
  // nothing about the applied text differs from what was typed without it appearing on screen.
  const cleaned = [];
  for (const entry of proposed) {
    const tidy = entry.value.trim().replace(/ {2,}/g, ' ');
    // Named whenever the typed text needed cleaning — including when cleaning turns it back into
    // what translations.ts already holds. That case applies nothing, and staying quiet about it is
    // the same silent drop the stanza-count check exists to prevent.
    if (tidy !== entry.value) cleaned.push(entry.key);
    entry.value = tidy;
  }

  const changes = proposed.filter((c) => c.value !== c.leaf.value);

  if (cleaned.length) console.log(`\nTidied stray/doubled spaces in: ${cleaned.join(', ')}`);

  if (!changes.length) {
    console.log(`\nNothing changed — all ${entries.length} strings match translations.ts already.\n`);
    return;
  }

  // Right to left, so each replacement leaves the earlier offsets valid.
  let out = src;
  for (const change of [...changes].sort((a, b) => b.leaf.start - a.leaf.start)) {
    out = out.slice(0, change.leaf.start) + `'${escapeLiteral(change.value)}'` + out.slice(change.leaf.end);
  }
  fs.writeFileSync(SOURCE, out, 'utf8');

  console.log(`\n${entries.length} strings read · ${changes.length} changed · ${entries.length - changes.length} left as they were.`);
  console.log(`\nUpdated in ${path.relative(ROOT, SOURCE)}:\n`);
  for (const change of changes) {
    console.log(`  ${change.key}`);
    console.log(`    was: ${change.leaf.value}`);
    console.log(`    now: ${change.value}`);
  }

  reportStaleFallbacks(changes);

  console.log('\nThe English for these keys is now out of date — that is the next step.\n');
}

// The three ways a hand-edited review file damages a string rather than rewording it. Each one
// produced a broken string on the first real review, and none of them is visible in the result:
// an emptied label renders as blank space, a joined line ships the English reference to the
// visitor, and a dropped {placeholder} silently prints a sentence with a hole in it.
function refuseOnDamage(changes) {
  const problems = [];
  for (const change of changes) {
    if (change.value === '') {
      problems.push(`${change.key} — would become empty`);
    }
    if (/ en: /.test(change.value)) {
      problems.push(`${change.key} — the \`en:\` reference line was joined into the Hebrew`);
    }
    const before = (change.leaf.value.match(/\{\w+\}/g) ?? []).sort().join(' ');
    const after = (change.value.match(/\{\w+\}/g) ?? []).sort().join(' ');
    if (before !== after) {
      problems.push(`${change.key} — placeholders changed: [${before}] → [${after}]`);
    }
  }

  if (!problems.length) return;
  console.error(`\nRefusing to apply — ${problems.length} damaged string(s):\n`);
  for (const problem of problems) console.error(`  · ${problem}`);
  console.error(`\nFix them in ${path.relative(ROOT, REVIEW_FILE)} and run again. Nothing was written.\n`);
  process.exit(1);
}

// --- set-en ------------------------------------------------------------------------------------

// The other half of the round-trip, and the half that is mine: after the Hebrew is applied, the
// English for those same keys is re-phrased and written back through here, from a JSON file of
// {key: english}. Same exact-range replacement as the Hebrew, so the two blocks stay in the shape
// the file already has.
function runSetEnglish(jsonPath) {
  if (!jsonPath) {
    console.error('\nUsage: node scripts/copy-review.mjs set-en <file.json>   // { "nav.home": "Home", ... }\n');
    process.exit(1);
  }

  const src = fs.readFileSync(SOURCE, 'utf8');
  const leaves = new Map(scanLanguageBlock(src, 'en').map((leaf) => [leaf.key, leaf]));
  const wanted = JSON.parse(fs.readFileSync(path.resolve(jsonPath), 'utf8'));

  const unknown = Object.keys(wanted).filter((key) => !leaves.has(key));
  if (unknown.length) {
    console.error(`\nRefusing to write — unknown key(s): ${unknown.join(', ')}\n`);
    process.exit(1);
  }

  const changes = Object.entries(wanted)
    .map(([key, value]) => ({ key, value, leaf: leaves.get(key) }))
    .filter((c) => c.value !== c.leaf.value);

  let out = src;
  for (const change of [...changes].sort((a, b) => b.leaf.start - a.leaf.start)) {
    out = out.slice(0, change.leaf.start) + `'${escapeLiteral(change.value)}'` + out.slice(change.leaf.end);
  }
  fs.writeFileSync(SOURCE, out, 'utf8');
  console.log(`\n${changes.length} English string(s) updated (${Object.keys(wanted).length - changes.length} already matched).\n`);
}

// --- stale fallbacks ---------------------------------------------------------------------------

// Client-side renderers carry the Hebrew a second time, as `i18n['key'] ?? 'טקסט'`. Those literals
// are what a visitor sees when the dictionary was not handed to the script, so a copy change that
// stops at translations.ts leaves the old wording live on exactly the paths that are hardest to
// notice. Reported rather than rewritten: the match is on the old string, and the same words can
// legitimately appear somewhere that is not a fallback for this key.
function reportStaleFallbacks(changes) {
  const byOldValue = new Map();
  for (const change of changes) {
    if (!byOldValue.has(change.leaf.value)) byOldValue.set(change.leaf.value, []);
    byOldValue.get(change.leaf.value).push(change);
  }

  const hits = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    if (file === SOURCE) continue;
    if (!/\.(ts|js|astro|mjs)$/.test(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const [oldValue, related] of byOldValue) {
        if (!line.includes(`'${oldValue}'`) && !line.includes(`"${oldValue}"`)) continue;
        hits.push({
          file: path.relative(ROOT, file),
          line: index + 1,
          keys: related.map((c) => c.key).join(', '),
          now: related[0].value,
        });
      }
    });
  }

  if (!hits.length) return;
  console.log(`\n${hits.length} place(s) in the code still carry the OLD Hebrew as a hard-coded fallback:\n`);
  for (const hit of hits) console.log(`  ${hit.file}:${hit.line}  (${hit.keys}) → should read: ${hit.now}`);
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

// --- entry -------------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
if (command === 'export') runExport(rest);
else if (command === 'apply') runApply();
else if (command === 'set-en') runSetEnglish(rest[0]);
else {
  console.error(
    '\nUsage:\n  npm run copy:review [-- section ...]   export the Hebrew for review\n' +
      '  npm run copy:apply                     write the edited Hebrew back\n' +
      '  node scripts/copy-review.mjs set-en <file.json>   write the matching English\n',
  );
  process.exit(1);
}
