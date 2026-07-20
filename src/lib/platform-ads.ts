import fs from 'node:fs';
import path from 'node:path';

const SETTINGS_PATH = path.join(process.cwd(), 'data/platform-ads.json');

// Platform-wide advertising knobs the owner controls from the admin Advertising
// tab (CURRENT_TASK.md → סשן ב׳). Deliberately tiny: the only things that are a
// real owner *decision* today. Everything else on that tab is derived/mock
// (see admin-ads.ts) until a real Google Ads / Meta account is connected.
//
// The baseline campaign uses a one-time LIFETIME budget, not a recurring one
// (AI_INSTRUCTIONS.md → Ads two-tier model): spend auto-stops at the cap instead
// of renewing monthly. `lifetimeBudget` of 0 = not set yet.
//
// Single-writer (one admin), so no mutex — swap-ready for a DB row like every
// other data/*.json.
export interface PlatformAdSettings {
  baselineStatus: 'active' | 'paused';
  lifetimeBudget: number; // ILS, one-time lifetime cap (0 = not set)
}

const DEFAULTS: PlatformAdSettings = { baselineStatus: 'active', lifetimeBudget: 0 };

function coerce(raw: Partial<PlatformAdSettings> | null | undefined): PlatformAdSettings {
  const budget = Number(raw?.lifetimeBudget);
  return {
    baselineStatus: raw?.baselineStatus === 'paused' ? 'paused' : 'active',
    lifetimeBudget: Number.isFinite(budget) && budget > 0 ? Math.round(budget) : 0,
  };
}

export function getPlatformAdSettings(): PlatformAdSettings {
  try {
    return coerce(JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as Partial<PlatformAdSettings>);
  } catch {
    return { ...DEFAULTS };
  }
}

export function updatePlatformAdSettings(updates: Partial<PlatformAdSettings>): PlatformAdSettings {
  const current = getPlatformAdSettings();
  const next = coerce({
    baselineStatus: updates.baselineStatus ?? current.baselineStatus,
    lifetimeBudget: updates.lifetimeBudget ?? current.lifetimeBudget,
  });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}
