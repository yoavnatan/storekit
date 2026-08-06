// Cloudflare-for-SaaS adapter — the real CustomHostnameProvider, active only when
// CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID are configured (see GO_LIVE §1). Talks to the
// "Custom Hostnames" API: register a seller's domain, poll its SSL/verification state, remove it.
// Best-effort by contract — every method swallows network/API errors and degrades gracefully so a
// Cloudflare hiccup can never break the seller dashboard flow that called it.
//
// Kept as its own file so custom-domain.ts (the contract + stub + resolver) carries no provider
// specifics — swapping Cloudflare for another edge SSL provider means writing one sibling file.

import type { CustomDomainCheck, CustomDomainVerification, CustomHostnameProvider } from './custom-domain.js';
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

  /**
   * The stored record for a hostname.
   *
   * `reached: false` is NOT the same answer as `hostname: null`, and collapsing the two is the bug
   * `CustomDomainCheck['unknown']` exists to prevent: the first says "we could not ask Cloudflare",
   * the second says "Cloudflare has no such hostname". Callers that only want a best-effort id
   * (register, remove) may treat them alike; `checkStatus` may not, because it is what the periodic
   * job writes to the database. An HTTP error is a failure to reach an ANSWER even though the
   * request itself completed, so a non-2xx counts as unreached too.
   */
  async function findId(hostname: string): Promise<{ reached: boolean; hostname: CfHostname | null }> {
    try {
      const res = await outboundFetch(`${API}/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`, { headers });
      if (!res.ok) return { reached: false, hostname: null };
      const data = await res.json() as { result?: CfHostname[] };
      return { reached: true, hostname: data.result?.[0] ?? null };
    } catch { return { reached: false, hostname: null }; }
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

    async checkStatus(hostname: string): Promise<{ status: CustomDomainCheck }> {
      const { reached, hostname: hn } = await findId(hostname);
      // Unreachable ⇒ no opinion. Reporting 'pending' here would let one Cloudflare outage demote
      // every verified domain on the platform at once (custom-domain.ts#CustomDomainCheck).
      if (!reached) return { status: 'unknown' };
      // Active only when Cloudflare reports both the hostname verified AND the certificate issued.
      const verified = hn?.status === 'active' && hn?.ssl?.status === 'active';
      return { status: verified ? 'active' : 'pending' };
    },

    async remove(hostname: string) {
      const { hostname: hn } = await findId(hostname);
      if (!hn?.id) return;
      try {
        await outboundFetch(`${API}/zones/${zoneId}/custom_hostnames/${hn.id}`, { method: 'DELETE', headers });
      } catch { /* best-effort — a stale CF record is harmless once the local record is cleared */ }
    },
  };
}
