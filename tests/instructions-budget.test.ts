import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The always-read budget, enforced instead of remembered.
 *
 * Every session begins by reading two slices of AI_INSTRUCTIONS.md — the rules before
 * `## Features built`, and `## Workflow` to EOF — before it can do anything at all. That read is the
 * first and most expensive thing a session does, and it had quietly quadrupled without anyone
 * noticing, because the budget written into the file was expressed in LINES:
 *
 *     2026-07-08  111 lines / 12.3k chars      2026-07-27  140 lines / 33.0k chars
 *     2026-07-14  117 lines / 21.7k chars      2026-07-30  153 lines / 52.2k chars
 *     2026-07-20  125 lines / 24.5k chars
 *
 * Lines grew 38%. Characters grew 324% — the average line went from 111 to 341 characters — so
 * "still under ~200 lines" read as headroom the entire way up. A budget measured in the wrong unit
 * is not a budget.
 *
 * So this is a ratchet, the same shape as .eslint-baseline.json: the ceiling records where we are,
 * and it may only ever come DOWN. Adding a rule is fine — pay for it by moving an equivalent amount
 * of rationale into the file it governs (a module header, a hook, GO_LIVE_CHECKLIST). That is a
 * relocation, never a deletion: nothing this project has learned should be lost to save bytes, and a
 * gotcha read at the moment it applies is worth more than one skimmed at session start.
 *
 * The 2026-07-31 pass did exactly that, 52.2k → 40.5k, and it is the worked example of where things
 * belong: the main.css split rule → main.css, the radius + tactile-depth scales → base/tokens.css,
 * the button feedback recipes → components/buttons.css, the header's layout rules →
 * Header.astro, the CSS on-contact exceptions and the legacy-file inventory →
 * .claude/hooks/remind-css-conversion.sh, the prefetch limit → astro.config.mjs, the sticky-layer
 * scroll targets → scroll-utils.ts, why no free trial → lib/pricing.ts, the lint-baseline history →
 * eslint.config.js, the payment-provider comparison → GO_LIVE_CHECKLIST §3.
 *
 * The 2026-08-03 pass moved two more: the six leave-as-CSS cases and the legacy-file inventory (the
 * hook already held them verbatim — this was deleting a duplicate, not relocating one), and the
 * ads gender/age_group trap → `lib/audience-infer.ts`. It also *added* the one-command testing rule,
 * paid for out of the same pass. 40.8k → 40.5k.
 *
 * The 2026-08-05 pass paid for the EDIT PERMISSION banner, which had been added without paying and
 * left this test red on main: the banner tightened to its rule, the "production monitoring — not yet
 * built" waypoint replaced by the fact that it now is (with pointers), and the self-healing-retry
 * plan → `lib/outbound-fetch.ts`, which is the module a retry policy would be built into. The trap
 * in that last one — never retry a non-idempotent operation, a retried checkout is a second charge —
 * is exactly the kind of thing worth more beside the code than skimmed at session start. 40.8k → 40.2k.
 *
 * Later the same day, the monitoring session's own close: the 'production monitoring — future
 * waypoint' bullet became a built one naming its four capture surfaces, and the six new modules
 * went into Project structure, which this budget deliberately does not count. 40,221 → 40,153.
 *
 * The 2026-08-09 shipping pass paid for the ShipOS decision line (the provider changed from a single
 * carrier to an aggregator, and the blocking question had to be where a session reads it before
 * building anything). Paid out of duplication in the same slice: the PayMe constraint line repeated
 * `market_fee`/"funds never pass through us" verbatim from the *Payment architecture* block fifteen
 * lines below it, and the authorize/capture mechanics live in GO_LIVE §3; the Store data-model note
 * carried the removed `flatRate`/`freeAbove` history, which GO_LIVE §5 holds. It also fixed a line
 * that had gone false — "Shipping — integrated carrier, **per-store config**, tracking", when the
 * 2026-07-27 decision is that a seller configures nothing but self-pickup. 40,153 → 40,106.
 *
 * When this fails, lowering CEILING to the new number is the wrong move unless the number went down.
 */
/**
 * **The anchoring trap, moved here from AI_INSTRUCTIONS §Workflow step 5 (2026-08-07) because this
 * is the file it governs.** `## Workflow` also appears EARLIER in that document as a
 * cross-reference, so `text.indexOf('## Workflow')` finds the mention rather than the section and a
 * naive slice comes out negative or empty. A reverse doc-check built that way once reported all 323
 * `src/` files as undocumented when the true count was zero. Anchor on LINE NUMBERS after
 * `## Features built`, never on the first substring match — which is what the finder below does,
 * and why its own "finds both section anchors" test exists.
 */
/**
 * 2026-08-09, two sessions in one day, and the second one found main already over the line — worth
 * recording because it is the first time this test failed on somebody else's merge rather than on
 * the session that was editing.
 *
 * The payments session settled the provider (+345 chars, unpaid: main sat at 40,472 against a
 * 40,153 ceiling). The session-workflow pass paid its own way — the Testing rule now names the hook
 * that blocks a hand-run check instead of arguing against one, and the budget bullet dropped two
 * fragments this file already carries — and then paid for the payments content too, out of what that
 * decision made redundant: the "per-store OR unified" bullet under *Payment architecture* had been
 * contradicting the new one-store-per-charge rule three paragraphs above it, and the *Business
 * model* line was restating the whole PayMe argument that now lives under *Payment architecture*.
 * Deleting a contradiction is the cheapest budget there is. 40,472 → 40,133.
 *
 * Later that day, the first block moved out to a hook rather than compressed: the money rules now
 * arrive on contact (`.claude/hooks/money-rules-on-contact.sh`) and the bullet keeps the rule plus
 * every module name, because a pointer is what makes a rule findable and the reverse-doc check
 * asserts they resolve. **Worth being honest about the size of this: 390 characters, ~100 tokens.**
 * The reason to do it is not the budget — it is that the traps behind those five modules now reach
 * the one session in five that edits money code, instead of being skimmed by the other four at
 * session start. Relocation buys attention here, not bytes. 40,106 → 39,743.
 */
/* Ratcheted down 39,743 → 39,554 on 2026-08-25. The gain was one relocation, not a trim: the
   "why on contact and never as a session of its own" reasoning behind the Tailwind rule moved into
   `.claude/hooks/remind-css-conversion.sh`, which re-injects it at the moment somebody is actually
   converting CSS — i.e. it is read MORE often now, not less, and by the session that needs it.
   That is the only move that lowers this number honestly. Shaving provenance out of a rule to buy
   bytes makes the rule easier to ignore, which costs more than the bytes are worth. */
const CEILING = 39_554;

const SRC = readFileSync(fileURLToPath(new URL('../AI_INSTRUCTIONS.md', import.meta.url)), 'utf8');

/** The two slices a session actually reads. */
function alwaysRead(text: string): { chars: number; lines: number } {
  const lines = text.split('\n');
  const featuresAt = lines.findIndex((l) => l.startsWith('## Features built'));
  // LAST occurrence, not the first: `## Workflow` also appears earlier as a cross-reference, and
  // anchoring on the first match yields an empty (or negative) slice that silently measures nothing.
  let workflowAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('## Workflow')) {
      workflowAt = i;
      break;
    }
  }
  return {
    chars: lines.slice(0, featuresAt).join('\n').length + lines.slice(workflowAt).join('\n').length,
    lines: featuresAt + (lines.length - workflowAt),
  };
}

describe('AI_INSTRUCTIONS.md always-read budget', () => {
  it('finds both section anchors', () => {
    // If either heading is renamed, the measurement below becomes meaningless rather than wrong —
    // fail loudly here instead of silently passing on a zero-length slice.
    expect(SRC).toContain('## Features built');
    expect(SRC.lastIndexOf('## Workflow')).toBeGreaterThan(SRC.indexOf('## Features built'));
  });

  it(`stays within the ${CEILING.toLocaleString()}-character ceiling`, () => {
    const { chars, lines } = alwaysRead(SRC);
    expect(
      chars,
      `The always-read part is now ${chars.toLocaleString()} chars across ${lines} lines — ` +
        `${(chars - CEILING).toLocaleString()} over the ceiling. Every session pays this before its ` +
        `first tool call. Do not raise CEILING: move an equivalent amount of rationale into the ` +
        `file it governs (module header, hook, GO_LIVE_CHECKLIST) and leave the rule + a pointer here.`,
    ).toBeLessThanOrEqual(CEILING);
  });

  it('is measured in characters, not lines — the unit that hid the growth', () => {
    const { chars, lines } = alwaysRead(SRC);
    // A line-count budget cannot see this file getting heavier, because its lines are paragraphs.
    // Asserting the average is well past a normal line length keeps that fact in front of whoever
    // is tempted to reintroduce a line-based limit.
    expect(chars / lines).toBeGreaterThan(150);
  });
});
