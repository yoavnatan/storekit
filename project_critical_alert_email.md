---
name: project_critical_alert_email
description: "A critical error emails the owner; every design decision in lib/critical-alert.ts is a limit, not a feature"
metadata: 
  node_type: memory
  type: project
  originSessionId: bd82f38e-4192-4631-8b9e-e144e6c3dfde
  modified: 2026-08-05T19:28:26.865Z
---

Built 2026-08-05. `lib/critical-alert.ts` — the ONLY thing in the app that reaches for a person
instead of waiting to be read. Fires from `logError` after a successful write, on
`severity === 'critical'` and nothing else ([[project_error_severity]]).

**The limits ARE the feature.** These channels die of noise, not silence: one broken deploy sends
400 mails, he makes a filter rule, and the next genuine alert lands in a folder nobody opens.
- One mail per **route** per 15 min (a failing checkout mails once, not once per buyer) — but a
  *different* critical route in the same window still gets through, because that's a new problem.
- 10/hour across all routes, in process — the per-route key is something a bad loop can vary.
- Dedup reads `error_log` itself (no new schema), via the `error_log_severity_idx` from 0013.
- **A failed dedup query SUPPRESSES.** When the DB is unwell the wrong direction to fail is the one
  that mails — that's the case failing on every route at once.
- Suppressed alerts still hit stderr. Silenced ≠ invisible.
- Never calls `logError` — it runs inside it; that would loop exactly when things are already wrong.

**The mail is self-sufficient — he must not need the dashboard to act** (`lib/error-reference.ts`,
added the same day after he asked "is there something I can copy to you, or a number linking the
two?"):
- **`errorRef(id)` → `#4f8c2a1e`** — first 8 chars of the uuid, in the mail subject AND on the
  dashboard row, so the two can be matched by eye. NOT `seq` (the natural incident number) because
  the DB assigns it on insert, after the mail is built; the uuid is ours beforehand.
- **`errorMeaning(route, severity)`** → "קונה לא הצליח להשלים רכישה" instead of "/api/checkout 500".
  Route-driven, never message-driven. Used by the mail AND the row, from one function.
- **A plain-text copy block with the stack**, one selection, in both mail parts. Stack cut at 1200
  chars and it SAYS it was cut.
- Subject order: meaning · route · ref — they fail in opposite directions (an unmapped route makes
  the sentence generic; the route alone means nothing to a non-developer).
- **`errorCopyText` is the ONE builder** for both the mail and the dashboard's copy button. There
  were two and they had drifted; only the stack cap differs (mail 1200, screen uncapped).
- **No copy BUTTON in a mail is possible** — every client strips JS. The link closes the loop
  instead: `?panel=alerts&alref=<8 chars>` narrows to that row, says on screen that it did, and an
  aged-out code says so rather than falling back to the whole list.
- **`/api/checkout` records the attempted cart** (product names ×qty, capped at 8) on the
  `resolutionHint`. Buyer email + store were already there — guest checkout included. The cart
  cannot be reconstructed after the fact, and "which item" is usually where triage ends.

**⚠️ His step at launch: set `ALERT_EMAIL` in `.env`.** Unset = feature off (the dev/CI state).
Documented in `.env.example` and GO_LIVE §4. Until the Resend key exists a send is a console line;
the day the key lands the same code delivers, no changes.

**Two bugs worth remembering as classes:** the alert was handed `logError`'s in-flight insert
payload, which has **no `createdAt`** (the row's timestamp is still in the database) — it compiled
and would have mailed "Invalid Date"; and the subject interpolated the route unescaped, where the
worry is CR/LF header injection, not `<` — `esc()` is the wrong tool for a header.
