/**
 * Reading `src/i18n/translations.ts` as SOURCE — every string leaf with the exact character range
 * of its literal, so one value can be rewritten without reformatting the file around it.
 *
 * This walk lived inside `scripts/copy-review.mjs` until the inline copy editor needed the same
 * thing from a running dev server (`src/pages/api/dev/copy.ts`). Two implementations of "find the
 * literal for this key" would be two chances to write a string into the wrong range, and that
 * failure is silent: an offset off by one produces valid-looking JavaScript with a corrupted
 * neighbouring string, which no compiler and no test would catch. So there is one walk, imported
 * by both callers.
 *
 * A regex per line cannot do this: the block holds comments (some containing quotes and braces),
 * nested objects, and an array of objects whose keys repeat per element.
 *
 * Plain `.mjs` rather than TypeScript because the two callers reach it differently — a Node CLI run
 * straight by `npm run`, and a Vite-compiled Astro route.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SOURCE = path.join(ROOT, 'src/i18n/translations.ts');

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
// literal.
export function scanLanguageBlock(src, lang) {
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

export function unescapeLiteral(raw) {
  // `r` alongside `n` and `t`, so a round trip through escapeLiteral returns the string it was given.
  return raw.replace(/\\(.)/g, (_, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch));
}

/**
 * `\r` is escaped for the same reason `\n` is, and it was missing: a carriage return is a JavaScript
 * LineTerminator, so one written raw into a single-quoted literal does not produce a wrong string —
 * it produces a file that does not parse, taking the dev server and the build down with it.
 *
 * It is reachable: text pasted out of Word or off a Windows machine carries `\r\n`, `tidy` collapses
 * spaces and trims but touches neither, and the inline editor's textarea is a paste target. U+2028
 * and U+2029 need no escaping — they have been legal inside string literals since ES2019.
 */
export function escapeLiteral(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Rewrite a set of `{ leaf, value }` pairs into the source text, right to left so each replacement
 * leaves the earlier offsets valid. Returns the new file contents; writing is the caller's.
 */
export function replaceLeaves(src, changes) {
  let out = src;
  for (const change of [...changes].sort((a, b) => b.leaf.start - a.leaf.start)) {
    out = out.slice(0, change.leaf.start) + `'${escapeLiteral(change.value)}'` + out.slice(change.leaf.end);
  }
  return out;
}

/**
 * Whether a leaf is one item of an ARRAY of strings — the shape where "delete this line" means the
 * item goes away, not that it becomes empty.
 *
 * Emptying a plain key leaves the element that prints it on screen with nothing in it; emptying an
 * array item leaves a bullet showing its marker and no words, which is worse and is what the owner
 * actually hit (2026-09-08: *"הבולט עצמו נשאר, פשוט ריק"*). The last segment being a number is the
 * whole test, because that is how `scanLanguageBlock` names an array position.
 */
export function arrayIndexOf(key) {
  const last = key.slice(key.lastIndexOf('.') + 1);
  return /^\d+$/.test(last) && key.includes('.') ? Number(last) : null;
}

/** The leaves of the array `key` belongs to, in index order. */
export function siblingsOf(leaves, key) {
  const prefix = key.slice(0, key.lastIndexOf('.') + 1);
  return leaves
    .filter((l) => l.key.startsWith(prefix) && arrayIndexOf(l.key) !== null)
    .sort((a, b) => arrayIndexOf(a.key) - arrayIndexOf(b.key));
}

/**
 * Delete a leaf's whole line when the literal has one to itself — which is how every array of
 * strings in this file is written, one item per line.
 *
 * Comments between items live on their own lines and are left alone: only the line the literal sits
 * on goes. When the literal SHARES a line (a one-line array), just the literal and one trailing
 * comma go, so the rest of that line survives intact.
 */
export function removeLeafLine(src, leaf) {
  const lineStart = src.lastIndexOf('\n', leaf.start) + 1;
  const nextNewline = src.indexOf('\n', leaf.end);
  const lineEnd = nextNewline === -1 ? src.length : nextNewline + 1;

  const ownsTheLine =
    /^\s*$/.test(src.slice(lineStart, leaf.start)) && /^\s*,?\s*$/.test(src.slice(leaf.end, lineEnd));
  if (ownsTheLine) return src.slice(0, lineStart) + src.slice(lineEnd);

  let end = leaf.end;
  if (src[end] === ',') end += 1;
  if (src[end] === ' ') end += 1;
  return src.slice(0, leaf.start) + src.slice(end);
}

/**
 * Put a string back on its own line beside `anchor`, at the indentation the neighbours use.
 * `after` places it below the anchor instead of above — the case where the removed item was last.
 */
export function insertLeafLine(src, anchor, value, after = false) {
  const lineStart = src.lastIndexOf('\n', anchor.start) + 1;
  const indent = /^[ \t]*/.exec(src.slice(lineStart))[0];
  const line = `${indent}'${escapeLiteral(value)}',\n`;
  if (!after) return src.slice(0, lineStart) + line + src.slice(lineStart);

  const nextNewline = src.indexOf('\n', anchor.end);
  const lineEnd = nextNewline === -1 ? src.length : nextNewline + 1;
  return src.slice(0, lineEnd) + line + src.slice(lineEnd);
}

/** Every `.ts/.js/.astro/.mjs` file under `src/`, except translations.ts itself. */
export function* sourceFiles() {
  yield* walk(path.join(ROOT, 'src'));
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (full !== SOURCE && /\.(ts|js|astro|mjs)$/.test(full)) yield full;
  }
}
