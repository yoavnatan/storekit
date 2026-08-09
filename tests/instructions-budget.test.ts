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
 * 2026-08-09, the session-workflow pass: §4 changed from "a worktree each, always" to "only when
 * another session is actually working in this tree", and the Testing rule now names the hook that
 * blocks a hand-run check. Both were paid for out of the same pass — the worktree close-out recipe
 * moved into `worktree-handoff.sh` (the hook that puts the decision in front of you) and the
 * budget bullet dropped two fragments this test already carries. 40,127 → 40,071.
 */
const CEILING = 40_071;

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
