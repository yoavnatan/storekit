// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { store } from './src/config/store.config.js';

// SEO note: `site` MUST be set to the real domain so canonical URLs,
// the sitemap and Open Graph absolute URLs are generated correctly.
export default defineConfig({
  site: store.url,

  // One canonical URL shape site-wide (no trailing slash) so /store/x and
  // /store/x/ never split into duplicate-content variants. Keeps the static
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

  // Passthrough: Cloudinary handles optimization via URL transforms (f_auto,q_auto,w_N).
  // Astro <Image /> enforces alt/width/height and adds loading/decoding attrs.
  image: {
    service: passthroughImageService(),
    responsiveStyles: true,
    domains: ['res.cloudinary.com', 'cdn.dummyjson.com'],
  },

  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      exclude: ['@imgly/background-removal'],
    },
  },
});
