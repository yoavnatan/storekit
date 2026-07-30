/**
 * Reading a server-side environment variable at RUNTIME.
 *
 * `import.meta.env.SOME_NAME` is not a lookup — it is a compile-time text
 * substitution: Vite inlines whatever the value was when the bundle was built.
 * On a server secret that is a trap that produces no error message. Measured
 * against a real `astro build` (2026-07-30): building without `AUTH_SECRET`
 * present collapses seller-auth's guard to a literal
 * `function secret(){ throw new Error('AUTH_SECRET is not set…') }` — the
 * constant folder removes the check because it can see the answer — so the
 * deployed server throws on EVERY request that touches a session, whatever the
 * process environment says, and the visitor just gets redirected. Meanwhile
 * `GO_LIVE_CHECKLIST.md` §7 promised the opposite: "set it in the server's
 * environment variables", "the server fails at boot".
 *
 * So every server-only variable is read through here, from the live
 * `process.env` — what the running process was actually configured with, the
 * value a host injects at deploy time, and what makes rotating a secret a
 * restart rather than a rebuild.
 *
 * There is deliberately no `import.meta.env[name]` fallback: it would look like
 * one and never fire. Astro hands private (non-`PUBLIC_`) variables to Vite as
 * `define` entries, i.e. text replacements for the literal
 * `import.meta.env.NAME`, so they are absent from the runtime env object a
 * dynamic key would read. Measured: a build made with `.env` present, served
 * with an empty environment, saw none of them.
 *
 * That leaves the `.env` file, which only `astro build` loads into
 * `process.env` (its env plugin, at buildStart). `astro dev` does not — so
 * `hydrateProcessEnv` below is called from astro.config.mjs for the dev server,
 * and dev, build and production then all read configuration the same way.
 *
 * `PUBLIC_*` variables are the deliberate exception and must keep using
 * `import.meta.env` directly: they are inlined into browser bundles on
 * purpose, and there is no `process` there. `import.meta.env.DEV`/`PROD`/
 * `MODE` are likewise genuinely build-time.
 *
 * Enforced by `tests/runtime-env.test.ts`, which scans `src/` for direct reads.
 */
export function serverEnv(name: string): string | undefined {
  const live = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return live || undefined;
}

/**
 * Copy `.env`-loaded values into `process.env` without overwriting anything the
 * process was really started with — a variable set in the shell or by the host
 * must win over a stale line in a local file, which is the precedence every
 * dotenv loader uses and the one a developer expects when overriding for one
 * run. Blank counts as unset, matching `serverEnv`.
 */
export function hydrateProcessEnv(loaded: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(loaded)) {
    if (!value) continue;
    if (process.env[name]) continue;
    process.env[name] = value;
  }
}

/**
 * A secret that must exist in production. Throws with the variable's name when
 * it is missing there; in dev returns `fallback` so the repo still runs from a
 * fresh clone. Kept here rather than duplicated per auth module so "how a
 * missing secret behaves" has one definition.
 */
export function requiredSecret(name: string, devFallback: string): string {
  const configured = serverEnv(name);
  if (configured) return configured;
  if (import.meta.env.PROD) {
    throw new Error(`${name} is not set. Refusing to fall back to the public dev default.`);
  }
  return devFallback;
}
