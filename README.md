# Modular Store (Astro)

<!-- EDIT PERMISSION: standing approval. Edit this file when the work requires it — never stop the session to ask. -->

A fast, SEO-first online store you can publish in minutes: configure the look,
add products — and you have a working store with cart, checkout and an admin area.

- **Astro** (static + selective SSR) — speed and high SEO out of the box
- **Plain CSS** with CSS custom properties — no Tailwind
- **Plain JavaScript** — no TypeScript

## Setup
```bash
npm install
npm run dev      # http://localhost:4321
```
Production build:
```bash
npm run build && npm run preview
```

## How to customize the store
| Want to change | Edit |
|---|---|
| Name, colors, logo, texts, sections | `src/config/store.config.js` |
| Products | `src/data/products.js` |
| Secrets (admin, payment, domain) | `.env` (copy from `.env.example`) |

## Built-in SEO
- meta + Open Graph + Twitter + canonical on every page (`src/components/Seo.astro`)
- Automatic sitemap and `robots.txt`
- Separate static page per product with `JSON-LD` (Product) for Google rich results
- Static content pages (fast load, full indexing)

## Internal docs
- **`AI_INSTRUCTIONS.md`** — working rules for Claude (hard rules, SEO, structure)
- **`CURRENT_TASK.md`** — what we're working on; updated every session

## Folder structure
```
src/config    modular store config
src/data      product catalog
src/pages     pages (home, products, checkout, admin, api)
src/components, src/layouts, src/lib, src/styles
public        favicon, robots.txt, images
```
