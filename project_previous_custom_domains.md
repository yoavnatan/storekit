---
name: project_previous_custom_domains
description: "A store's old custom domains 301 like an old slug does — migration 0015 + store_previous_domains"
metadata: 
  node_type: memory
  type: project
  originSessionId: 84ba00c2-4e08-44ac-a09b-7b4143d4c410
  modified: 2026-08-06T16:43:52.970Z
---

Moving a store TO a custom domain deliberately consolidates its whole ranking onto that host (the
301 in `customDomainRedirectUrl`). So removing the domain — or swapping A for B — used to 404 every
link, bookmark and indexed page the store had earned there. The platform path never dies; the
seller's domain did.

Fixed 2026-08-06, shaped exactly like `store_previous_slugs` (0001), which already solves the same
problem for the other half of the URL:

- **migration 0015** → `store_previous_domains (hostname citext PK, store_id, replaced_at)`, capped
  at `MAX_PREVIOUS_DOMAINS` = 5 per store.
- `/api/store.ts` remembers the old host **before** clearing/overwriting the record (after that
  there is nothing left to redirect from), and `claimCustomDomainHostname` deletes any previous-owner
  row when a host is registered — otherwise the store that once used it would 301 away the store
  that owns it now.
- the middleware consults it **only** when no active store claims the host, just before the 404
  branch, and redirects via the pure `custom-domain.ts#previousDomainRedirectUrl`.

Works only while the old host still resolves to us (the CNAME is the seller's to remove) — which is
the common case and the only one anyone could serve.

See also [[project_ad_platform_account_risk]], [[project_custom_domain_recheck]], [[project_domain_switch]].
