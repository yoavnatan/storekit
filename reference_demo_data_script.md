---
name: reference_demo_data_script
description: "scripts/seed-demo-data.mjs controls all demo data — seed, clean, tune scale/backgrounds"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5fa53fec-2d21-4e1b-8ebe-a3a0293521f8
---

`scripts/seed-demo-data.mjs` is the single tool for demo data (built 2026-07-19). Node ESM, keyless, idempotent.

**Commands:**
- `node scripts/seed-demo-data.mjs` — seed (needs internet; pulls real product photos from DummyJSON)
- `node scripts/seed-demo-data.mjs --clean` — remove ALL demo data, keep real seller data

**What it makes:** ~35 Hebrew-branded stores across 12 verticals + 3 English "department" stores (MegaMart/City Market/The Bazaar) with 100 products each (draw from the full ~194-product catalog → exercises the 24/page storefront pagination). ~800 products total, all with real product images, plus orders/pageviews/favorites/wishlist so dashboards render full.

**Key design:**
- Demo entities tagged to demo sellers (email `@demo.local`); `--clean` filters only those, never touches real data. Log in as any demo seller: `sellerN@demo.local` / password `demo1234`.
- Real products come from DummyJSON (keyless catalog API) — image always matches product name.
- 5 stores get coloured (pastel) product backgrounds via Cloudinary on-the-fly `fetch` + `e_make_transparent` — needs Cloudinary "Fetched URL" enabled (Settings → Security). Script self-tests and silently stays white if fetch is off.
- Config at top of file: `TINT` (which stores get coloured bg), `VERTICALS` (`big:N` = department store size), `MAX_PER_STORE`.
- `astro.config.mjs` image `domains` must include `cdn.dummyjson.com` (+ `res.cloudinary.com`) for images to render.

Tried+rejected image sources: picsum (generic, not products), LoremFlickr (403 blocked), Pexels/Unsplash (need API keys; Unsplash gives ambiance not clean product shots). DummyJSON won on clean white-bg product photos. See [[feedback_dev_server]].
