/// <reference types="astro/client" />

interface Window {
  dataLayer?: Record<string, unknown>[];
  fbq?: (action: string, event: string, params?: Record<string, unknown>) => void;
  __sessionUserId: string;
  __pendingCartSync: 'merge' | 'replace' | '';
  /** The store's verified custom hostname when the page is served on it (else ''); set by
   *  initCustomDomainLinks so the shared product modal builds clean root-relative URLs. */
  __customStoreHost?: string;
  /** Switches a `.dash-tabs` strip to the given tab. Defined by the inline
   *  <DashTabsBoot /> script so tabs work before the page's JS bundle lands;
   *  initDashTabs() (keyboard arrows) calls it rather than re-implementing it. */
  __dashTabActivate?: (tab: HTMLElement) => void;
  /** A menu trigger clicked inside a panel whose JS had not loaded yet. The panel's
   *  loader replays it once that panel is wired, so the tap opens the menu a beat
   *  late instead of being swallowed. Only `[aria-haspopup]` openers are ever stored. */
  __dashPendingClick?: HTMLElement | null;
  /** Scrolls an overflowing `.dash-tabs` strip sideways so the given tab is visible —
   *  the strip only, never the page (a sticky strip makes scrollIntoView jump the
   *  document). Same file, same reason as __dashTabActivate. */
  __dashTabReveal?: (tab: HTMLElement) => void;
  /** Scrolls an element back below the dashboard's pinned chrome, and does nothing when it is
   *  already fully on screen. Published by initUnsavedGuard for the inline draft guard, which must
   *  still work on a load where no module arrived — see its comment there. */
  __dashScrollTo?: (el: HTMLElement) => void;
}
