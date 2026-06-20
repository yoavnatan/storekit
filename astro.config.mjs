// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { store } from './src/config/store.config.js';

// SEO note: `site` MUST be set to the real domain so canonical URLs,
// the sitemap and Open Graph absolute URLs are generated correctly.
export default defineConfig({
  site: store.url,

  // Hybrid rendering: pages are static by default (best SEO + speed),
  // and only the few that need a server (cart actions, checkout, admin)
  // opt into SSR with `export const prerender = false`.
  output: 'static',
  adapter: node({ mode: 'standalone' }),

  integrations: [
    sitemap(),
  ],

  // Built-in image optimization helps Core Web Vitals (LCP).
  image: {
    responsiveStyles: true,
    // Allow Cloudinary as an external image service for Astro <Image />
    domains: ['res.cloudinary.com'],
  },

  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      exclude: ['@imgly/background-removal'],
    },
  },
});
