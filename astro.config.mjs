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
    sitemap({
      filter: (page) => !/\/(admin|checkout|seller|buyer|search)(\/|$)/.test(new URL(page).pathname),
    }),
  ],

  devToolbar: { enabled: false },

  // Astro's own prefetch (no ClientRouter, no soft navigation) — opt-in per link
  // via `data-astro-prefetch`, never site-wide: prefetching every link on a
  // product-dense page would download store pages nobody asked for. Marked links
  // fetch their HTML on hover/touch-start, so the click that follows renders from
  // cache instead of waiting on the server. Genuine navigations only — Back keeps
  // using bfcache, which is still the one path that restores with zero work.
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
      watch: {
        ignored: ['**/data/**'],
      },
    },
  },
});
