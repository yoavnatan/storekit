// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import { loadEnv } from 'vite';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { store } from './src/config/store.config.js';
import { hydrateProcessEnv } from './src/lib/runtime-env.js';

/**
 * Make the `.env` file visible to the DEV server.
 *
 * Server-only configuration is read from `process.env` (src/lib/runtime-env.ts — the
 * `import.meta.env.NAME` form is a build-time text substitution and cannot be filled in at
 * runtime). Astro loads `.env` into `process.env` itself, but only during `astro build`; the
 * dev server never does, and private variables are handed to Vite as `define` replacements,
 * which a runtime lookup cannot see. Without this, every server variable in `.env` —
 * GOOGLE_CLIENT_ID, RESEND_API_KEY, ADMIN_SECRET — silently read as unset under `astro dev`,
 * and each one degrades quietly rather than erroring: no Google button, console emails, and
 * /admin back on its dev-default password.
 *
 * Same loader Astro uses (`loadEnv` with an empty prefix = every variable, not just PUBLIC_).
 */
function dotEnvForDevServer() {
  return {
    name: 'dezabin:dotenv-for-dev-server',
    apply: 'serve',
    config(/** @type {unknown} */ _config, /** @type {{ mode: string }} */ { mode }) {
      hydrateProcessEnv(loadEnv(mode, process.cwd(), ''));
    },
  };
}

// SEO note: `site` MUST be set to the real domain so canonical URLs,
// the sitemap and Open Graph absolute URLs are generated correctly.
export default defineConfig({
  site: store.url,

  // One canonical URL shape site-wide (no trailing slash) so /<store> and
  // /<store>/ never split into duplicate-content variants. Keeps the static
  // sitemap, the dynamic sitemap, canonical tags, and internal links all in the
  // same form. Root ("/") is unaffected.
  trailingSlash: 'never',

  // Hybrid rendering: pages are static by default (best SEO + speed),
  // and only the few that need a server (cart actions, checkout, admin)
  // opt into SSR with `export const prerender = false`.
  output: 'static',
  adapter: node({ mode: 'standalone' }),

  integrations: [
    // Static sitemap covers only build-time-known public routes. The private,
    // auth-gated / transactional pages must not be advertised to search engines
    // (they were leaking into the sitemap: /admin, /checkout, /seller, /buyer).
    // Store + product pages are SSR, so they're not here at all — they're
    // enumerated at runtime by /sitemap-content.xml (referenced from robots.txt).
    // `/search` is intentionally noindex (search-result pages), so it must not be
    // advertised in the sitemap either — Search Console flags "submitted URL marked
    // noindex" otherwise. `/stores` stays: its base (unfiltered) page IS indexable;
    // only its filtered variants set noindex, and those aren't build-time routes.
    // `/store-gone` and `/store-unavailable` are the same case as `/search` and were missed
    // (fixed 2026-08-05): both set `noindex={true}` in their own frontmatter, and both were being
    // advertised in the sitemap regardless — the exact "submitted URL marked noindex" contradiction
    // the note above describes, waiting in Search Console on the day it gets connected. They are
    // status pages a shopper is redirected to, never destinations to arrive at from a search.
    sitemap({
      filter: (page) => !/\/(admin|checkout|seller|buyer|review|search|store-gone|store-unavailable)(\/|$)/.test(new URL(page).pathname),
    }),
  ],

  devToolbar: { enabled: false },

  // Astro's own cross-site POST protection: an on-demand route refuses a form-encoded request
  // whose `Origin` is not this site. It is ALREADY Astro's default — pinned here anyway because
  // the default is conditional in a way that is invisible from this file: it applies only when the
  // build output is `server`, which for `output: 'static'` means "only while at least one route
  // still says `prerender = false`". Every page does today; the day one of those lines moves, this
  // protection would switch itself off with no error and no diff to point at.
  // It is the FIRST of three layers, not the whole of it — `sameSite:'lax'` session cookies are
  // the zeroth, and `src/lib/csrf.ts` is the signed-token layer that does not depend on either.
  security: { checkOrigin: true },

  // Astro's own prefetch (no ClientRouter, no soft navigation) — opt-in per link
  // via `data-astro-prefetch`, never site-wide: prefetching every link on a
  // product-dense page would download store pages nobody asked for. Marked links
  // fetch their HTML on hover/touch-start, so the click that follows renders from
  // cache instead of waiting on the server. Genuine navigations only — Back keeps
  // using bfcache, which is still the one path that restores with zero work.
  // Marked today: the product page's "לחנות" link, StoreCard, the homepage spotlight tile and
  // its shelf-header store link (both point at a store page, like StoreCard), and the SEARCH
  // result card. That search card is the ONLY product-page link marked anywhere, and the reason
  // is the limit below rather than a preference: the store page's product name is hijacked into
  // the quick-view modal, so prefetching it would download a page the click does not open.
  // The limit worth knowing before you try to work around it (moved here from AI_INSTRUCTIONS.md
  // 2026-07-31): prefetch binds only to links PRESENT AT LOAD, so a link built later via innerHTML
  // — the quick-view modal's "לדף המוצר המלא" — cannot use it, and `astro:prefetch`'s prefetch()
  // refuses it too, because while the modal is open that URL *is* the current URL.
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },

  // Passthrough: Cloudinary handles optimization via URL transforms (f_auto,q_auto,w_N).
  // Astro <Image /> enforces alt/width/height and adds loading/decoding attrs.
  image: {
    service: passthroughImageService(),
    responsiveStyles: true,
    domains: ['res.cloudinary.com', 'cdn.dummyjson.com'],
  },

  vite: {
    plugins: [dotEnvForDevServer(), tailwindcss()],
    optimizeDeps: {
      exclude: ['@imgly/background-removal'],
    },
    // Dev-only: let a fake `*.test` hostname reach the dev server (Vite otherwise blocks unknown
    // Hosts as DNS-rebinding protection). This is purely for locally testing the custom-domain
    // routing (map `demo-shop.test` → 127.0.0.1 in /etc/hosts). Ignored by the production build.
    server: {
      allowedHosts: ['.test'],
      // Dev-only: `data/` is the JSON "database", and the app WRITES to it while
      // serving — a store or product page view stamps store-pageviews.json and
      // analytics-events.json. Vite watches the project root, so each of those
      // writes looked like a source edit and forced a full reload, which served
      // the page again, which counted another view, which wrote again: a browser
      // tab left open on any store page reloaded itself every few seconds
      // (measured 5 reloads in 20s). It also masked real work, since a reload
      // mid-rebuild serves a half-stale script bundle. Nothing in data/ is ever
      // imported as a module — it's read at request time — so ignoring it costs
      // no HMR. Production is unaffected: the build doesn't watch anything.
      // Same class, three more sources — none of them source code, all of them written
      // WHILE the dev server is up, and each one costing a full page reload in whatever tab
      // the owner is looking at (owner, 2026-08-22: *"למה כל פעם כשאני שומר פה ב-current_task
      // פתאום זה מרענן לי את הדפדפן?"*).
      //   `**/*.md`      — the project's prose: CURRENT_TASK.md is edited in the IDE, on and off,
      //                    all session; AI_INSTRUCTIONS.md and GO_LIVE_CHECKLIST.md are written by
      //                    the assistant mid-session. There is no markdown in the module graph at
      //                    all (no content collections, no `.md` import anywhere in `src/`), so
      //                    ignoring every one of them cannot cost a legitimate HMR update.
      //   `**/.claude*/**` — the harness's own writes: `.claude/` (hook state, worktrees, session
      //                    scratch) and `.claude-memory/` (the memory repo, ~200 files, rewritten
      //                    whenever a memory is saved). Nothing under either is imported.
      //   `coverage/` — vitest's report, rewritten by every run of `npm run verify`.
      // Everything here is checked against the same bar as `data/` above: not in the module
      // graph, therefore ignoring it costs no HMR.
      //
      // **The directory patterns are ANCHORED to this tree's own root, and that is a bug fix, not
      // tidiness** (2026-08-22, found by the owner: *"אני גם לא רואה את השינויים בשרת של
      // הפרוטוטייפ"*). They were written as `**/.claude/**`, which matches a path SEGMENT anywhere
      // — and a worktree of this repo lives at `<root>/.claude/worktrees/<name>/`. A dev server
      // started inside one therefore matched its own `src/` against that pattern and stopped
      // watching its entire source tree: no HMR, no invalidation, and a page that keeps serving
      // whatever Vite happened to have in its module graph. The stylesheet still looked current,
      // because Vite re-reads a CSS file on request; the page module did not, so the symptom was
      // "some of my changes are there and some are not", which reads as a broken edit rather than a
      // broken watcher. `process.cwd()` is the root of whichever checkout is running, so in a
      // worktree this means "that worktree's own `.claude/`" — which is what was always meant.
      // `**/*.md` stays a bare glob on purpose: markdown is out of the module graph everywhere,
      // including inside a worktree, so there is nothing for it to break.
      watch: {
        ignored: [
          `${process.cwd()}/data/**`,
          `${process.cwd()}/.claude/**`,
          `${process.cwd()}/.claude-memory/**`,
          `${process.cwd()}/coverage/**`,
          '**/*.md',
        ],
      },
    },
  },
});
