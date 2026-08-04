-- 0010_order_attribution — stamping the ad click that produced an order (GO_LIVE §2.5, layer 5).
--
-- **What this is for.** The "מכירות" figure on a campaign card is an ATTRIBUTION, not a count of
-- orders: Google and Meta each join their own click log to a conversion pixel, each fills the gaps
-- it cannot join with MODELLED numbers, and each will happily claim the same sale. Summing two
-- networks can therefore report more sales than the store actually took. `lib/ad-metrics.ts`
-- (`RangeStat.conversions`) states that rule in full and the seller-facing glossary is written to
-- match it.
--
-- First-party attribution is the only deterministic version of that number, and this column is
-- where it lands: the click id off the landing URL, kept in a first-party cookie for the lookback
-- window, stamped onto the order at checkout. Then "sales from this campaign" is a `WHERE` over
-- real order rows — a list, not an estimate — and the double-claim above resolves, because an order
-- carries exactly one attribution record.
--
-- **Why `jsonb` and not ten columns.** The repo's own line: a fixed shape that SQL does arithmetic
-- on gets typed columns (`order_stores.discount_*`), a fixed shape that is only ever read back
-- whole gets `jsonb` (`stores.sale`, `stores.feed_sync`, `stores.hours`). Attribution is a label —
-- nothing sums it, nothing compares it to money — and it is written and read by exactly one module
-- (`src/lib/attribution.ts`), which is what makes the absent schema-level CHECK affordable. Ten
-- mostly-NULL text columns would also have to be spelled out four more times (the row type, the
-- SELECT list, the row mapper, the INSERT) for no query this app will ever run.
--
-- **The shape**, all keys optional except the last:
--   gclid, gbraid, wbraid  — Google. `gbraid`/`wbraid` are not decoration: on iOS, when ATT is
--                            declined, Google sends those INSTEAD of `gclid`, and dropping them
--                            would mean the mobile half of a campaign lands with no attribution at
--                            all while looking like it simply did not convert.
--   fbclid                 — Meta.
--   utmSource … utmTerm    — the five UTM parameters, which is what a non-network channel
--                            (newsletter, a partner link) has instead of a click id.
--   landedAt               — ISO timestamp of the landing that produced the record. REQUIRED, and
--                            it is what makes a lookback window expressible at all: Google's
--                            default is 30 days from the click and Meta's is 7-day-click, so a
--                            report has to ask "how long before this order was the click" per
--                            network. Without it the cookie's own TTL would silently force one
--                            window on both, and changing it would rewrite history.
ALTER TABLE orders ADD COLUMN attribution jsonb;

-- The report this exists to serve: "orders belonging to campaign X, in this date range". Partial,
-- so the overwhelming majority of orders — organic, direct, and every order placed before ad
-- accounts existed — cost nothing to keep out of it.
CREATE INDEX orders_attribution_campaign_idx
  ON orders ((attribution->>'utmCampaign'), created_at DESC)
  WHERE attribution IS NOT NULL;
