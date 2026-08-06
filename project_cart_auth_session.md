---
name: project-cart-auth-session
description: Auth + cart persistence architecture — decisions and implementation
metadata: 
  node_type: memory
  type: project
  originSessionId: f27eaf58-eb8c-496e-ae69-ac3d46be216a
---

Cart + wishlist server-side persistence implemented via `data/user-carts.json` (keyed by sellerId).  
**Why:** localStorage alone can't persist carts across devices or when switching users.  
**How to apply:** Any checkout or cart-related feature must read/write via `/api/user-cart` (GET/POST) for logged-in users. `src/lib/cart-sync.ts` handles client-side merge/save logic.

Auth flow (decided + implemented):
- Register = account only (no forced store). Store created later from dashboard.
- Login/register/logout all use `?next=` to return user to origin page.
- Dashboard shows "open first store" CTA when user has no stores (no redirect to login).
- Login/register pages use `sellerMode={true}` to suppress nav bar.

Cart isolation per user — `BaseLayout` inline script tracks `__cu` in localStorage:
- guest → login: `__pendingCartSync = 'merge'` (keep guest items + load server items, max qty on conflict)
- logout: clear local (server already has latest via debounced save at 1.2s)
- user A → user B without logout: clear + `__pendingCartSync = 'replace'`
