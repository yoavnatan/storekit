-- The hostnames a store used to be served from, so an old link does not die when it moves.
--
-- `store_previous_slugs` (0001) already solves exactly this for the other half of a store's URL: a
-- seller renames their store, every link earned under the old slug 301s to the new one, and the
-- ranking transfers instead of being lost. A custom domain had no such memory. Removing one — or
-- swapping domain A for domain B — erased the record, so every link, bookmark and indexed page on
-- the old host answered 404 the moment the seller changed their mind. That is the worst possible
-- outcome for the store that had done the most to build an audience: the platform path is the one
-- URL that never dies, and switching TO a custom domain deliberately consolidates all of a store's
-- ranking onto a host we then forgot about.
--
-- Only reachable while the old host still resolves to us (the seller's CNAME is theirs to remove).
-- That is the common case by far — a seller "removes the domain" in the dashboard and never touches
-- their registrar — and it is the only case anyone could serve anyway.
--
-- Shaped exactly like `store_previous_slugs`, deliberately: hostname is the primary key because one
-- hostname can only ever have belonged to one store at a time, and claiming it as an ACTIVE domain
-- deletes any previous-owner row (see stores.ts#claimCustomDomainHostname) — otherwise a store that
-- once used `shop.example` would keep 301-ing away the store that owns it now.
--
-- citext: hostnames are case-insensitive, and the lookup happens on a raw request Host header.
CREATE TABLE IF NOT EXISTS store_previous_domains (
  hostname    citext PRIMARY KEY,
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_previous_domains_store_idx ON store_previous_domains (store_id, replaced_at DESC);
