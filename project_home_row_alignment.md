---
name: project-home-row-alignment
description: "Homepage rows (shelves + spotlight carousel) must begin AND end on the container line — cards are sized to a whole-number fit, never a fixed width with a peek"
metadata: 
  node_type: memory
  type: project
  originSessionId: b5e234dd-acf4-4701-aafb-73201eace9d4
  modified: 2026-07-30T15:44:49.746Z
---

Every horizontal row on the homepage — `.home-shelf` (store cards) and `.home-carousel` (product tiles) — must start and end exactly on the container's content line (1128px at full width), at every viewport. Card width is therefore a SHARE of the row: `max(share(card count), share(--shelf-fit))` in store-card.css, where `--shelf-fit` / `--carousel-fit` are per-breakpoint "how many fit" ladders. A short row fills; a long row shows a whole number of cards and scrolls.

**Why:** the user reported this twice in one session (2026-07-30) — first a 24px tail on 3-card shelves, then, once those ended flush, that the longer shelves and the carousel beside them still ended mid-card. "זה צריך להסתיים באותו הקו. למרות הפייד" — a sliced card next to a flush one reads as the row not matching the width of the site. He accepts the edge fade as the "there's more" signal; he does not accept a ragged termination.

**Mobile has no peek, on purpose (asked about and decided the same day).** A phone row shows exactly 2 whole cards; the "there's more" signal is the edge fade, widened there to 40px (`--edge-fade-w` on `.home-shelf`, and the carousel's own overlay to match). A real peek would need the card to drop from 166px to ~150px on a 375px screen — 10% of an already small card — and would put a cut card next to a whole one again, which is the thing reported twice. Don't shrink that fade back to the 24px default, and don't "restore" a peek.

**How to apply:** never reintroduce a fixed card width (`clamp(190px, 46vw, 240px)` was the old one) or a "peek" of a partial card — including on mobile, where rows now show exactly 2 cards. Three traps that cost a debugging round each, all documented in the code: `calc(… / min(a,b))` fails to parse silently (divide by a plain `var()`, take `max()` of the two shares instead); a flex item's default `min-width:auto` floors a card at its own min-content width, so `min-width:0` is required or the share is only a request; and a scroll container with `padding-inline` needs a matching `scroll-padding-inline` or `scroll-snap-align:start` parks the row 8px out of line with its non-scrolling neighbours. Related: [[feedback_clean_design_line]].
