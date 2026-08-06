---
name: project_custom_domain_recheck
description: "The hourly custom-domain re-check job — 'unknown' never demotes, and a mass demotion is refused as our failure"
metadata: 
  node_type: memory
  type: project
  originSessionId: 84ba00c2-4e08-44ac-a09b-7b4143d4c410
  modified: 2026-08-06T16:32:24.301Z
---

`custom_domain_status` decides whether a seller's store is served from their own domain at all, and
until 2026-08-06 it was written ONLY when a human pressed "check" in the dashboard. A seller who
unpointed their CNAME took their own store offline permanently and silently; a domain that finished
verifying after they closed the tab stayed 'pending' forever.

Now: `jobs/registry.ts` → `custom-domain-check`, hourly, 50 at a time, rotating on
`custom_domain_checked_at` (migration 0014). One shared step for the button and the timer:
`lib/custom-domain-verify.ts`. Either direction notifies the seller (`domain_status` notification).

**Two defences, and they are the point:**

- **`CustomDomainCheck` has three members, not two.** `'unknown'` means the provider could not be
  ASKED, and is never written. Before this, the Cloudflare adapter swallowed every error and
  returned `'pending'` — harmless for a button, catastrophic for a timer, which would read one
  expired API token as "every seller unpointed their DNS at once". The dev stub also answers
  `'unknown'`, so a deploy with missing credentials is inert instead of destructive.
- **A demotion pass that would demote more than `demoteCeiling(n)` = max(3, n/4) stores demotes
  NONE of them**, logs an error and says so in the job line. The scenario is specific: a WRONG ZONE
  ID answers perfectly well, with an empty result for every hostname — a believable "not verified"
  for the whole platform. Promotions are never capped; a false promotion is not destructive.

See also [[project_ad_platform_account_risk]], [[project_scheduler]], [[project_domain_switch]].
