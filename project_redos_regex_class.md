---
name: project-redos-regex-class
description: "quadratic-regex DoS class — request-controlled input into a backtracking regex; two fixed 2026-07-29, helpers + guard tests exist"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2b1d3bee-5dee-40de-9221-ab6c830a2914
  modified: 2026-08-01T21:48:28.274Z
---

A regex whose worst case is quadratic, fed a string whose length the request controls, stalls the
whole site — Astro SSR is single-threaded Node, so one request blocks every other. Two instances
existed and are fixed (2026-07-29), each now behind a helper with a grep guard test:

- `src/lib/email-address.ts` — `isValidEmail` + `MAX_EMAIL_LENGTH` (254, RFC 5321), replacing the
  copy-pasted `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. That pattern is quadratic because `[^\s@]` also
  matches the dot; measured 3.8s on a 64KB `buyerEmail`, and `/api/checkout` is unauthenticated.
  Guard: `tests/email-address.test.ts`.
- `src/lib/url-base.ts` — `stripTrailingSlashes`, replacing `replace(/\/+$/, '')` at 6 sites. One of
  them was `Seo.astro` on the raw `Astro.url.pathname`; 4.3s on 64k slashes. Guard:
  `tests/url-base.test.ts`.

**Third instance, 2026-08-02 — the same `X+$` shape, in dashes.** `replace(/^-+|-+$/g, '')` was
hand-rolled at four slug sites: `stores.ts#normalizeSlug`, `store-products.ts#slugify` (both fed a
name/slug that arrives with the request) and two dashboard URL previews that ran it **per keystroke
on the raw input field**. Measured on interior dashes: 65ms at 8k, **4.7s at 64k**. The two server
sites were safe only because a `.replace(/-+/g, '-')` collapse happened to run first — safety as a
property of LINE ORDER, one refactor from a stall; the two client ones had no collapse and were
genuinely vulnerable to a paste. All four now call `url-base.ts#trimDashes` (a charCode scan), with
a grep guard in `tests/url-base.test.ts` alongside the trailing-slash one. **The lesson worth
keeping: I found this while reviewing my OWN diff against the checklist** — the pattern arrived by
being copied from the neighbouring `normalizeSlug`, which is how this class propagates.

**Why:** this sits with [[project_attribute_escaping_xss]] and [[project_json_script_xss]] as a
known class, and the same lesson as [[feedback_new_state_sweep_consumers]] — the email pattern was
duplicated across three modules and simply absent from seller registration, so a seller could
register against an address that could never receive a password reset (fixed, `auth.invalidEmail`
added to both locales).

**How to apply:** any regex with two `+`/`*` runs that can match the same character, applied to
request data, is suspect. Do not trust the eyeball — **measure it**, doubling the input and watching
the time quadruple; my first read of the email pattern was wrong (it is linear on a dotless domain,
quadratic only when many dots force the tail to re-scan). Length-cap before matching, and prefer a
backwards `charCodeAt` scan over an anchored `X+$`. `npm run lint` flags candidates via
`sonarjs/super-linear-regex`, but most of its hits are on config constants or client-side code —
triage by "who controls the input length", not by count.
