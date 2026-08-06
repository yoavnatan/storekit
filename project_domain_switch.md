---
name: project_domain_switch
description: "The platform domain is dezabin.co.il (settled 2026-08-05, was .com); a rename is NOT config-only — one test asserts against the platform host"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4f1f04d2-03e6-4b3b-a201-7550b6581636
  modified: 2026-08-04T14:56:25.459Z
---

**The platform domain is `https://dezabin.co.il`** — settled 2026-08-05. It was `dezabin.com` since registration; the owner asked whether Israel-only should mean a `.co.il`, and the answer was yes.

**Why, in one fact:** Google **removed Search Console's country-targeting control in September 2022**. A gTLD has no way left to *declare* its market — geography is inferred from ccTLD, hreflang, server location and content. On `.com` the Israeli intent was something to hope Google would infer; on `.co.il` it is stated in the address. (The content signals — Hebrew, ₪, Israeli addresses — were already strong, so this is an improvement, not a transformation. Trust with Israeli shoppers, used to `zap.co.il` / `yad2.co.il`, probably matters as much.)

**`.com` stays registered and 301s to `.co.il`.** That is the option-preserving move, not a commitment: a visitor typing it still arrives, ranking signal consolidates on one host instead of splitting across two identical ones, and if the platform ever leaves Israel the redirect reverses. **The 301 is registrar/DNS configuration — not code, and NOT DONE YET.**

**A domain rename here is NOT config-only.** `store.url` in `src/config/store.config.ts` is the single source that propagates to canonical/OG/sitemaps, but three other kinds of place hold it literally:
- `public/robots.txt` — a STATIC file with two hardcoded `Sitemap:` lines.
- **`tests/custom-domain.test.ts` — load-bearing.** It asserts the PLATFORM host is *refused* when a seller tries to claim it as their own custom domain. Change the config alone and it goes on asserting that against a hostname the platform no longer owns.
- Comments/fixtures across `src/lib/`, `scripts/lib/seed-db.mjs` and several tests.

After renaming, `grep -rn "dezabin\.com" --include=*.ts --include=*.mjs --include=*.txt --include=*.md` should return only `CURRENT_TASK.md` (user-owned, never edited by me).

**IndexNow key is set** (`seo.indexNowKey`, 2026-08-05). It is **not a secret** — the protocol requires it readable at `/<key>.txt`, which `src/pages/[key].txt.ts` serves and which IS the ownership proof. Inert until a real domain: `indexnow.ts` refuses to submit from a placeholder host.

Related: [[project_platform_name]], [[project_seo_priority]], [[reference_go_live_checklist]].
