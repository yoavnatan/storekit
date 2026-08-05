// Cloudflare-for-SaaS adapter — the real CustomHostnameProvider, active only when
// CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID are configured (see GO_LIVE §1). Talks to the
// "Custom Hostnames" API: register a seller's domain, poll its SSL/verification state, remove it.
// Best-effort by contract — every method swallows network/API errors and degrades gracefully so a
// Cloudflare hiccup can never break the seller dashboard flow that called it.
//
// Kept as its own file so custom-domain.ts (the contract + stub + resolver) carries no provider
// specifics — swapping Cloudflare for another edge SSL provider means writing one sibling file.

import type { CustomDomainStatus, CustomDomainVerification, CustomHostnameProvider } from './custom-domain.js';
import { cnameTarget } from './custom-domain.js';
import { outboundFetch } from './outbound-fetch.js';

const API = 'https://api.cloudflare.com/client/v4';

interface CfHostname {
  id: string;
  ssl?: { status?: string };
  status?: string;
  ownership_verification?: { type?: string; name?: string; value?: string };
}

export function createCloudflareProvider(token: string, zoneId: string): CustomHostnameProvider {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  async function findId(hostname: string): Promise<CfHostname | null> {
    try {
      const res = await outboundFetch(`${API}/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`, { headers });
      const data = await res.json() as { result?: CfHostname[] };
      return data.result?.[0] ?? null;
    } catch { return null; }
  }

  return {
    name: 'cloudflare',

    async register(hostname: string) {
      const verification: CustomDomainVerification = { cnameTarget: cnameTarget() };
      try {
        const res = await outboundFetch(`${API}/zones/${zoneId}/custom_hostnames`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ hostname, ssl: { method: 'http', type: 'dv' } }),
        });
        const data = await res.json() as { success?: boolean; result?: CfHostname; errors?: { message?: string }[] };
        if (!res.ok || !data.success) {
          return { ok: false, verification, error: data.errors?.[0]?.message ?? `HTTP ${res.status}` };
        }
        const ov = data.result?.ownership_verification;
        if (ov?.name && ov.value) { verification.txtName = ov.name; verification.txtValue = ov.value; }
        return { ok: true, verification };
      } catch (err) {
        return { ok: false, verification, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async checkStatus(hostname: string): Promise<{ status: CustomDomainStatus }> {
      const hn = await findId(hostname);
      // Active only when Cloudflare reports both the hostname verified AND the certificate issued.
      const verified = hn?.status === 'active' && hn?.ssl?.status === 'active';
      return { status: verified ? 'active' : 'pending' };
    },

    async remove(hostname: string) {
      const hn = await findId(hostname);
      if (!hn?.id) return;
      try {
        await outboundFetch(`${API}/zones/${zoneId}/custom_hostnames/${hn.id}`, { method: 'DELETE', headers });
      } catch { /* best-effort — a stale CF record is harmless once the local record is cleared */ }
    },
  };
}
