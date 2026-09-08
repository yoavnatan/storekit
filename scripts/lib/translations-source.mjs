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
  return raw.replace(/\\(.)/g, (_, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
}

export function escapeLiteral(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
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
