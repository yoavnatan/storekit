import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The tab shell is split on purpose: activation lives in the inline
// <DashTabsBoot /> script so a tab responds before the page's JS bundle lands
// (the seller dashboard's is ~61 KB gzipped — on a weak mobile connection that
// was seconds of a page that looked ready and answered nothing). initDashTabs()
// keeps only the module-dependent extras and calls window.__dashTabActivate.
//
// The failure mode that split creates: a page renders a tab strip and forgets
// the boot, and the strip is simply dead — no error anywhere, and it looks fine
// on a fast connection because nothing else switches tabs either. So: any page
// with a [role="tab"][data-panel] strip MUST render <DashTabsBoot />.

const PAGES_DIR = join(process.cwd(), 'src/pages');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.astro') ? [full] : [];
  });
}

describe('DashTabsBoot', () => {
  it('is rendered by every page that renders a dash-tabs strip', () => {
    const missing = walk(PAGES_DIR).filter((file) => {
      const src = readFileSync(file, 'utf8');
      const hasStrip = /role="tab"/.test(src) && /data-panel=/.test(src);
      return hasStrip && !src.includes('<DashTabsBoot');
    });

    expect(missing.map((f) => f.replace(process.cwd() + '/', ''))).toEqual([]);
  });

  it('keeps activation in ONE place — ui.ts must not re-implement it', () => {
    const ui = readFileSync(join(process.cwd(), 'src/scripts/dashboard/ui.ts'), 'utf8');
    // A second copy silently drifts from the inline one, and every tab click
    // would run both. initDashTabs() delegates instead.
    expect(ui).toContain('__dashTabActivate');
    expect(ui).not.toMatch(/dispatchEvent\(new CustomEvent\('dashtab:show'/);
  });

  it('the boot script is inline — a network fetch would defeat the whole point', () => {
    const boot = readFileSync(join(process.cwd(), 'src/components/dashboard/DashTabsBoot.astro'), 'utf8');
    expect(boot).toContain('<script is:inline>');
    expect(boot).not.toMatch(/\bimport\s/);
  });
});
