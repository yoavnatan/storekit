---
name: project_custom_domain_host_surfaces
description: "Every surface that must answer differently on a seller's custom domain — robots.txt, sitemap, IndexNow — plus the www/apex twin and the platform-host guard"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8d3cf059-ae06-4038-a1be-d9639a399dca
  modified: 2026-08-06T17:19:56.563Z
---

A verified custom domain does not just *serve* the store — it changes what several
machine-facing surfaces must **say**. Each one is per-host, and each was found broken separately.

- **`src/pages/robots.txt.ts` is SSR, not `public/robots.txt`** (2026-08-06). A static file answers
  every hostname identically, so a seller's domain got the platform's two `Sitemap:` lines. A
  cross-host sitemap reference is ignored by every engine, so that domain declared **none** while
  `sitemap-content.xml` already served it a correct one. On a custom host it names that host's
  sitemap only and does **not** re-invite `/api/feed/` (Merchant Center fetches the feed from the
  platform domain and only there — [[project_ad_platform_account_risk]]).
- **A file in `public/` silently outranks a route of the same name.** Re-adding one restores the old
  behaviour in full while the route sits there looking correct. Guarded in `external-contract.test.ts`.
- **A 5xx on robots.txt = Google pauses crawling the whole site for hours.** Its DB lookup falls back
  to the platform answer instead of failing the response — same principle as `/api/health`.
- **The www/apex twin** (`custom-domain.ts#hostnameAlias`): a domain is one hostname in our record
  and two spellings in the seller's registrar. The unregistered spelling used to 404 on the seller's
  own brand; `middleware.ts#unclaimedHostRedirect` 301s it to the claimed one, next to the
  migration-0015 previous-domain 301 ([[project_previous_custom_domains]]).
- **The platform host skips the whole custom-domain block**, and `normalizeHostname` refuses any
  host `isPlatformHost` claims (incl. `PLATFORM_HOSTS`: staging, the Cloudflare fallback origin).
  Before that the router and the claim path disagreed, and every platform page load paid an indexed
  SELECT that could only ever return null.

**Why:** a domain change is not one switch — it is every surface that names a host, and each one
fails silently and separately. **How to apply:** adding a host-dependent surface (feed variant, a
new sitemap, an ownership file) means asking "what does this say on the seller's domain?" before
shipping it, and putting the answer in a test. Related: [[project_custom_domain_recheck]],
[[project_seo_priority]].
