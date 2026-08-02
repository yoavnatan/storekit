import { firstRow, query } from './db.js';
import { toAgorot } from './money.js';

/**
 * Platform-wide advertising knobs the owner controls from the admin Advertising tab
 * (CURRENT_TASK.md → סשן ב׳). Deliberately tiny: the only things that are a real owner *decision*
 * today. Everything else on that tab is derived/mock (see admin-ads.ts) until a real Google Ads /
 * Meta account is connected.
 *
 * The baseline campaign uses a one-time LIFETIME budget, not a recurring one (AI_INSTRUCTIONS.md →
 * Ads two-tier model): spend auto-stops at the cap instead of renewing monthly. `0` = not set yet.
 *
 * **Stored in `app_settings`, not a table of its own (DB_MIGRATION_PLAN.md §8).** Two fields with
 * exactly one row is not a table; the keyed jsonb store keeps it beside `admin_tab_views` and stays
 * additive — a third knob is a key in the object, not a migration.
 *
 * **What that costs, and how it is paid.** A jsonb value takes no column type and no CHECK, so
 * neither `bigint` range nor `>= 0` is enforced by the database the way it is on the two campaign
 * tables. The budget is still money and still §7.7 — integer agorot, named `lifetimeBudgetAgorot`
 * so the unit cannot change under a stable name — and the validation the column would have given
 * is `coerce()` below, which every read AND every write goes through. That is the deliberate
 * trade: the constraint lives in one function instead of one column. Until this, the API accepted
 * any finite number at all, so `1e30` was a valid lifetime budget.
 */
export interface PlatformAdSettings {
  baselineStatus: 'active' | 'paused';
  /** One-time lifetime cap in integer agorot (0 = not set). */
  lifetimeBudgetAgorot: number;
}

/** Ceiling on the platform's own lifetime ad budget, in ILS. Nothing this side of a funding round
 *  approaches it; what it stops is an absurd value reaching the reporting and the future
 *  Authorize/Capture hold (CURRENT_TASK #22). */
export const MAX_LIFETIME_BUDGET = 10_000_000;

const MAX_LIFETIME_BUDGET_AGOROT = toAgorot(MAX_LIFETIME_BUDGET);
const SETTINGS_KEY = 'platform_ads';
const DEFAULTS: PlatformAdSettings = { baselineStatus: 'active', lifetimeBudgetAgorot: 0 };

/**
 * The gate — on the way out of the database as well as in.
 *
 * Reading through it too is not belt-and-braces: the row may have been written by an older deploy
 * (the import carried the pre-agorot shape) or by a future one, and a settings object that renders
 * `NaN ₪` because the stored value was a string is worse than one that renders the default.
 */
function coerce(raw: Partial<PlatformAdSettings> | null | undefined): PlatformAdSettings {
  const budget = Number(raw?.lifetimeBudgetAgorot);
  const valid = Number.isFinite(budget) && budget > 0;
  return {
    baselineStatus: raw?.baselineStatus === 'paused' ? 'paused' : 'active',
    lifetimeBudgetAgorot: valid ? Math.min(Math.round(budget), MAX_LIFETIME_BUDGET_AGOROT) : 0,
  };
}

/** An owner-typed budget in ILS → integer agorot, or null if it is not a budget. Out of range is a
 *  rejection, not a clamp: silently booking 10,000,000₪ for someone who typed more is a figure
 *  nobody chose. */
export function parseLifetimeBudgetAgorot(v: unknown): number | null {
  const ils = Number(v);
  if (!Number.isFinite(ils) || ils < 0 || ils > MAX_LIFETIME_BUDGET) return null;
  return toAgorot(ils);
}

export async function getPlatformAdSettings(): Promise<PlatformAdSettings> {
  const row = await firstRow<{ value: Partial<PlatformAdSettings> | string }>(
    'SELECT value FROM app_settings WHERE key = $1',
    [SETTINGS_KEY],
  );
  if (!row) return { ...DEFAULTS };
  // `pg` parses `jsonb` for us; a driver that hands back the raw text must not become a 500.
  const value = typeof row.value === 'string' ? safeParse(row.value) : row.value;
  return coerce(value);
}

function safeParse(text: string): Partial<PlatformAdSettings> | null {
  try { return JSON.parse(text) as Partial<PlatformAdSettings>; } catch { return null; }
}

/**
 * Write the knobs the request actually carried, leaving the rest alone.
 *
 * One statement, and the merge happens inside it: `value || $2` is jsonb concatenation, which
 * overwrites only the keys present on the right. Reading the row, spreading in JS and writing it
 * back would lose a concurrent change to the OTHER key — one admin today, but that is a fact about
 * this month rather than a property of the code.
 */
export async function updatePlatformAdSettings(updates: Partial<PlatformAdSettings>): Promise<PlatformAdSettings> {
  const patch: Partial<PlatformAdSettings> = {};
  if (updates.baselineStatus === 'active' || updates.baselineStatus === 'paused') {
    patch.baselineStatus = updates.baselineStatus;
  }
  if (updates.lifetimeBudgetAgorot !== undefined) {
    patch.lifetimeBudgetAgorot = coerce({ lifetimeBudgetAgorot: updates.lifetimeBudgetAgorot }).lifetimeBudgetAgorot;
  }

  const { rows: written } = await query<{ value: Partial<PlatformAdSettings> | string }>(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = app_settings.value || EXCLUDED.value, updated_at = now()
     RETURNING value`,
    [SETTINGS_KEY, JSON.stringify(patch)],
  );
  const value = written[0]?.value;
  return coerce(typeof value === 'string' ? safeParse(value) : value);
}
