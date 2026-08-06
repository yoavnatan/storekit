---
name: project-runtime-env-reading
description: "Server env vars must be read from process.env via src/lib/runtime-env.ts; import.meta.env is build-time text substitution and Astro fills process.env only during build, so astro.config.mjs hydrates it for dev"
metadata: 
  node_type: memory
  type: project
  originSessionId: 518c0ced-6f08-46ee-8f4f-ee2a6b734e41
  modified: 2026-07-30T13:05:06.180Z
---

`import.meta.env.NAME` in this repo is NOT a lookup — Astro hands private (non-`PUBLIC_`)
variables to Vite as `define` entries, i.e. text replacement of that exact literal. Measured
2026-07-30: a build made with `.env` present, then served with an empty environment, saw none of
those values, and a `.env`-free build constant-folded seller-auth's guard into an unconditional
`throw` that no runtime environment could undo.

So: every server-only variable goes through `serverEnv`/`requiredSecret` in `src/lib/runtime-env.ts`,
which reads `process.env` only — there is deliberately no `import.meta.env[name]` fallback, because a
dynamic key can never see a `define`d value. `tests/runtime-env.test.ts` scans `src/` and fails on the
direct form.

The trap that follows: Astro loads `.env` into `process.env` **only during `astro build`** (its env
plugin, at buildStart). `astro dev` does not, so without help every server variable in `.env` reads as
unset in dev, and each one fails *quietly* — no Google button, console-only email, /admin back on its
dev-default password. `astro.config.mjs` therefore runs a dev-only (`apply: 'serve'`) Vite plugin
calling `hydrateProcessEnv(loadEnv(mode, cwd, ''))`; a shell-exported value still wins.

`PUBLIC_*` is the deliberate exception and keeps using `import.meta.env` — it is inlined into browser
bundles on purpose.

**Why:** the two halves are separately non-obvious and both fail silently rather than loudly.
**How to apply:** never read a server variable off `import.meta.env`; when a `.env` value seems to
"not take" in dev, check the config plugin before suspecting the code. Related: [[project-store-readiness-gate]].
