// Static analysis: the SonarJS rule engine (the same rules the "SonarQube for IDE"
// extension shows in the editor) plus TypeScript and Astro parsing, so the whole tree
// is covered from the CLI via `npm run lint`.
//
// Scope on purpose: type errors stay with `astro check`, behaviour stays with vitest.
// This layer only hunts bug patterns and dead code. Style-only Sonar rules are off —
// a lint run nobody can read is a lint run nobody runs.
//
// How the baseline got honest (moved here from AI_INSTRUCTIONS.md 2026-07-31, where it was
// costing every session a read it almost never needed): the first `.eslint-baseline.json` was
// generated from an uncommitted working tree, so 17 of its 106 findings sat in 11 files that
// were not in git at all — frozen as "pre-existing" by timing rather than by review. All 17
// were triaged on 2026-07-30: 3 were real bugs and were fixed, 3 rules were switched off below
// with the reason stated at each (`no-inverted-boolean-check` in particular wanted `!(x > 0)`
// rewritten as `x <= 0`, which is a *different* check — NaN fails every comparison), and the
// rest became local disables that name why. `super-linear-regex` is a warning, not an error,
// because only 2 of its 19 findings were real. The baseline is now 62 errors across 25 files
// and may only ever shrink.
//
// The two commands that are not `npm run lint` (moved here 2026-08-05 for the same reason as the
// paragraph above — the always-read budget): `npm run lint:all` is the WHOLE picture, backlog and
// warnings included, for a dedicated cleanup session rather than a normal one; after clearing
// some, `npm run lint:prune` drops the suppressions that no longer match anything. Warnings never
// gate anything by design.
//
// And if a rule becomes noise, turn it off HERE with the reason written next to it. The
// alternative — learning to skim past it — is how a gate stops working while still passing.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import astro from 'eslint-plugin-astro';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      '.astro/',
      'node_modules/',
      'data/',
      'public/',
      'pics/',
      '.claude-memory/',
      '.claude/worktrees/',
      // Dot-prefixed one-off verification snippets (throwaway Playwright/Node scripts written to
      // check a change, then deleted). They are never committed, and CI lints a CLEAN checkout,
      // so they can never reach the real gate — linting them locally only means one session's
      // scratch file turns `npm run lint` red for another session's unrelated work, which
      // happened, and a red gate you learn to explain away is a gate that stopped working.
      // Only the dot-prefixed form is listed: an ESLint ignore without a slash matches a
      // BASENAME at any depth, so `check-*.mjs` would also skip scripts/check-required-env.mjs,
      // a real file that must stay linted. .gitignore keeps the undotted root scratch names out
      // of the repo, root-anchored for the same reason.
      '.tmp-*',
      '.*.mjs', '.*.cjs',
      // The `<name>.tmp.<ext>` infix form of the same convention. Safe as an
      // unanchored basename pattern for the reason the dotted ones are not
      // enough on their own: `.tmp.` in the middle of a filename is never a
      // real module here, only a scratch probe somebody left behind.
      '*.tmp.mjs', '*.tmp.cjs', '*.tmp.js', '*.tmp.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  ...astro.configs.recommended,

  {
    rules: {
      // tsc already reports these; a second voice saying the same thing is noise.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',

      // Readability opinions, not defects — they buried the real findings.
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/no-nested-template-literals': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/single-char-in-character-classes': 'off',
      'sonarjs/use-type-alias': 'off',
      'sonarjs/todo-tag': 'off',
      'sonarjs/no-commented-code': 'off',

      // `!(x > 0)` is not the same check as `x <= 0` and the rule's suggested rewrite is a bug:
      // NaN fails EVERY comparison, so the inverted form catches it and the "opposite operator"
      // form lets it through. All 3 findings at introduction were NaN guards on numbers parsed
      // from user input or image metadata — a discount value, a percentage, an image scale —
      // where following the rule would have shipped "-NaN%" and a NaN-wide element.
      'sonarjs/no-inverted-boolean-check': 'off',

      // Fires on this codebase's one-line guard style — `if (a) x(); if (b) y();` — where the
      // braces are present and the sequencing is exactly what was meant. All 11 hits at
      // introduction were reviewed one by one and all 11 were false positives.
      'sonarjs/no-unenclosed-multiline-block': 'off',

      // A warning, not an error: it is a heuristic with a poor hit rate here. Of 19 findings at
      // introduction 2 were real — both genuine denial-of-service holes, both fixed — and the other
      // 17 were on config constants, browser-only code, or test files, where nothing hostile
      // controls the input. Blocking CI on a check that is wrong 17 times out of 19 trains everyone
      // to bypass it. The real protection is tests/email-address.test.ts and tests/url-base.test.ts,
      // which measure elapsed time on hostile input instead of pattern-matching the source.
      'sonarjs/super-linear-regex': 'warn',

      // Complexity: worth knowing, never worth blocking.
      'sonarjs/cognitive-complexity': ['warn', 25],
      'sonarjs/no-nested-functions': ['warn', { threshold: 5 }],
    },
  },

  {
    // Inline <script is:inline> blocks are hand-written ES5 on purpose (they ship
    // unbundled, before hydration), so `var` there is a decision, not a slip.
    // The plugin hands script blocks to ESLint as virtual `<file>.astro/*.js` paths,
    // so matching only '**/*.astro' would miss exactly the code this targets.
    files: ['**/*.astro', '**/*.astro/*.js', '**/*.astro/*.ts'],
    rules: { 'no-var': 'off' },
  },

  {
    // Node scripts and config files, not browser code.
    files: ['scripts/**', '*.config.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
    rules: {
      'sonarjs/no-hardcoded-passwords': 'off',
      'sonarjs/pseudo-random': 'off',
    },
  },

  {
    files: ['tests/**'],
    languageOptions: { globals: globals.node },
    rules: {
      // Assertion-phrasing preferences; the tests already assert the right thing.
      'sonarjs/prefer-specific-assertions': 'off',
      'sonarjs/no-hardcoded-passwords': 'off',
      // Same reasoning one rule further: a test that proves the dev-fallback secret is refused in
      // production has to name that fallback. `tests/admin-auth.test.ts` signs with it precisely
      // to assert the token is REJECTED.
      'sonarjs/hardcoded-secret-signatures': 'off',
      'sonarjs/pseudo-random': 'off',

      // An insecure URL in a test is the INPUT, not a deployment: all 4 findings at introduction
      // were assertions that an `http://` value gets rejected or sanitised away. A test proving we
      // refuse cleartext has to contain a cleartext URL to refuse.
      'sonarjs/no-clear-text-protocols': 'off',

      // Exactly the same shape one rule further, and for the SSRF guard specifically: the literal
      // addresses in `tests/feed-fetch-ssrf.test.ts` ARE the subject — 169.254.169.254 is the cloud
      // metadata endpoint the guard exists to refuse, and ::ffff:127.0.0.1 is the spelling a
      // hand-rolled check forgets. Naming them is the test; there is nothing to configure instead.
      'sonarjs/no-hardcoded-ip': 'off',

      // tests/form-fallback-guard.test.ts runs the component's own `<script is:inline>` body
      // through `new Function`, which is the only way to test the shipped code rather than a
      // copy of it. The input is a file read off disk at test time, not anything a request reaches.
      'sonarjs/code-eval': 'off',
    },
  },
);
