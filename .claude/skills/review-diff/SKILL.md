---
name: review-diff
description: Review the working diff against this repo's own failure history — the bug classes that have actually shipped here. Use before reporting done on any change touching money, auth, inventory, cart, checkout, or admin/seller data. The Stop hook triggers this automatically; it can also be invoked directly.
---

# Review the working diff

`/code-review` and `/security-review` cannot be launched by the model — they are user-triggered only.
This is the model-side substitute, and it is deliberately **not** generic review advice: it is the list
of things that have actually broken in *this* codebase. A generic reviewer re-derives nothing; this
list is the accumulated cost of past sessions.

## How to run it

1. Get the diff. `git diff` plus `git status --short` for untracked files — much of this repo's work is
   uncommitted, so a diff against HEAD alone misses whole files.
2. Read every changed hunk. Not the summary, not the filenames — the hunks.
3. Walk the checklist below against what the diff actually touches. Skip sections the diff cannot
   reach, and say which you skipped and why.
4. For each finding: state the concrete failure (inputs → wrong result), fix it, and add or extend a
   test. Per AI_INSTRUCTIONS.md, a gap is never "out of scope" — fix on sight, then check whether the
   whole class has the same hole elsewhere.
5. Verify: `astro check`, `npm run lint`, `npm test`.
6. Record the review so the Stop hook lets the turn end:
   `bash .claude/hooks/record-review.sh`
7. Report what you checked, what you found, and what you skipped. If you found nothing, say that
   plainly — do not invent findings to look thorough.

## Checklist

### Money and reporting
- **A status value that excludes an order from revenue must be honoured by every reader.** Cancelled
  orders counted as revenue for seven sessions because the rule lived in several modules. Adding or
  changing a status means grepping every reader of that field. `lib/reconcile.ts` computes the same
  figures a second way — if it disagrees, trust it over the code you just wrote.
- **Prices are recomputed server-side, never taken from the client.** The cart is client state and
  every API route is directly callable.
- **Anything that moves money or decrements stock needs a Vitest test in the same change.** Not
  follow-up work — the same change.
- **Rounding goes through `lib/money.ts`.** Float equality on money is a defect, not a style choice.

### Untrusted input
- **Every request-supplied destination goes through `lib/safe-redirect.ts`** — `?next=`, a cookie
  carrying one, a `Referer`. This was copy-pasted into four routes and missing from a fifth, which is
  how `/api/lang` became an open redirect.
- **Every email intake goes through `lib/email-address.ts`.** Length cap before pattern.
- **A regex with two `+`/`*` runs that can match the same character, applied to request data, is a
  denial-of-service vector.** Measure it — double the input, watch the time quadruple. Do not
  eyeball it. See `lib/url-base.ts` for why an anchored `X+$` is not safe on a request path.
- **Bounds and types are checked on the server even when the UI already checks them.** A disabled
  button is not a rule.

### Escaping and injection
- **An escaper used inside `attr="…"` must escape `"`.** Skipping it is the exact hole fixed at
  `escapeHtml`/`escH`.
- **`set:html={JSON.stringify(data)}` inside a `<script>` is an XSS sink** — `</script>` is not
  escaped by `JSON.stringify`. Use `lib/json-script.ts`.
- **Image URLs are not validated server-side.** Treat any stored URL rendered into markup as
  attacker-controlled.

### Authorization and scoping
- **A record replayed or returned to a caller must be bound to that caller.** A hard-to-guess
  identifier is not authorization — see `checkoutOwner` in `lib/checkout-idempotency.ts`.
- **Multi-store orders must never leak one seller's data to another.** `scopeOrder` exists because
  the whole `sellerNotes` map used to go to the client.
- **A seller may not act on a store they do not own.** Check ownership from the session, not from a
  slug in the request.

### Architecture
- **A rule that appears in two modules is the next bug.** Extract it and add a grep guard test that
  fails if anyone hand-rolls it again — `tests/safe-redirect.test.ts` and
  `tests/email-address.test.ts` are the pattern.
- **Astro built-ins and existing `src/lib` modules before a new parallel mechanism.** Two systems for
  one job fight each other.
- **JSON files are dev-only and must stay swap-ready for the DB.** No shared write state. Ask whether
  it breaks at 1000 sellers.

### Correctness traps specific to this codebase
- **`.astro` attribute expressions**: `attr="text" + (expr)` is not valid — it silently becomes junk
  attributes and the expression vanishes. Use `attr={`…${expr}`}`. This shipped once.
- **`toggle('hidden')` is a no-op on a flex element here** — use `'!hidden'`.
- **A save must never revert a field the seller did not touch** (`lib/record-rev.ts`, per-field merge).
- **New dashboard forms needing a real browser POST must carry `data-native-submit`**, or
  `FormFallbackGuard` blocks them.

## What this cannot do

It reads a checklist; it does not read intent the way a person does, and it will miss a class nobody
has written down yet. When a change is large or genuinely novel, say so and suggest the user run
`/code-review` for an independent pass. Never claim that ran.
