/// <reference types="astro/client" />

interface Window {
  dataLayer?: Record<string, unknown>[];
  fbq?: (action: string, event: string, params?: Record<string, unknown>) => void;
  __sessionUserId: string;
  __pendingCartSync: 'merge' | 'replace' | '';
  /** The store's verified custom hostname when the page is served on it (else ''); set by
   *  initCustomDomainLinks so the shared product modal builds clean root-relative URLs. */
  __customStoreHost?: string;
}
