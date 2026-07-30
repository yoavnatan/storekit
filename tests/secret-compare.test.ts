// Behaviour of the constant-time comparison, plus a guard so the pattern it replaced cannot
// come back. Four call sites had hand-rolled `===` on a secret — two session signatures, the
// admin cookie, and the admin password — which is the same shape as every other rule in this
// codebase that rotted: correct in most places, simply missing from one.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { allSecretsEqual, secretsEqual } from '../src/lib/secret-compare.js';

describe('secretsEqual', () => {
  it('accepts identical strings', () => {
    expect(secretsEqual('s3cret', 's3cret')).toBe(true);
    expect(secretsEqual('', '')).toBe(true);
  });

  it('rejects different strings', () => {
    expect(secretsEqual('s3cret', 's3crev')).toBe(false);
    expect(secretsEqual('a', 'b')).toBe(false);
  });

  it('rejects a length mismatch instead of throwing', () => {
    // timingSafeEqual throws on unequal-length buffers; comparing digests is what avoids that,
    // and the throw would itself have leaked the secret's length.
    expect(() => secretsEqual('short', 'a much longer value')).not.toThrow();
    expect(secretsEqual('short', 'a much longer value')).toBe(false);
    expect(secretsEqual('', 'x')).toBe(false);
  });

  it('is not fooled by a prefix', () => {
    expect(secretsEqual('admin', 'admin-extra')).toBe(false);
    expect(secretsEqual('admin-extra', 'admin')).toBe(false);
  });
});

describe('allSecretsEqual', () => {
  it('is true only when every pair matches', () => {
    expect(allSecretsEqual([['a', 'a'], ['b', 'b']])).toBe(true);
    expect(allSecretsEqual([['a', 'a'], ['b', 'c']])).toBe(false);
    expect(allSecretsEqual([['a', 'x'], ['b', 'b']])).toBe(false);
    expect(allSecretsEqual([])).toBe(true);
  });

  it('evaluates every pair rather than short-circuiting', () => {
    // A wrong username must not cost less work than a wrong password: `userOk && passOk` would
    // answer early and tell the guesser which half was wrong.
    let compared = 0;
    const pairs: Array<readonly [string, string]> = [
      ['wrong', 'right'],
      ['also-wrong', 'right'],
    ];
    for (const [a, b] of pairs) { compared++; void secretsEqual(a, b); }
    expect(allSecretsEqual(pairs)).toBe(false);
    expect(compared).toBe(2);
  });
});

/** Every .ts file under src/, so a new module is covered without editing this test. */
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) srcFiles(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('no hand-rolled secret comparison', () => {
  it('compares signatures and secrets only through secret-compare.ts', () => {
    const root = path.join(process.cwd(), 'src');
    const offenders: string[] = [];

    // A comparison operator on either side of a signing call or a secret getter. Deliberately
    // narrow: it names the shapes that actually appeared, so it cannot drown in false positives.
    const patterns = [
      /(?:sign|adminSecret|secret)\s*\([^)]*\)\s*(?:===|!==|==|!=)/,
      /(?:===|!==|==|!=)\s*(?:sign|adminSecret|secret)\s*\(/,
      /\b(?:password|passphrase|apiKey|sig|signature)\s*(?:===|!==)\s*(?!undefined|null|''|""|'string')/,
    ];

    for (const file of srcFiles(root)) {
      if (file.endsWith(path.join('lib', 'secret-compare.ts'))) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
        if (patterns.some((p) => p.test(line))) {
          offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders, `use secretsEqual() from src/lib/secret-compare.ts instead:\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});
