// Static analysis: the SonarJS rule engine (the same rules the "SonarQube for IDE"
// extension shows in the editor) plus TypeScript and Astro parsing, so the whole tree
// is covered from the CLI via `npm run lint`.
//
// Scope on purpose: type errors stay with `astro check`, behaviour stays with vitest.
// This layer only hunts bug patterns and dead code. Style-only Sonar rules are off —
// a lint run nobody can read is a lint run nobody runs.
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
      'sonarjs/pseudo-random': 'off',
    },
  },
);
