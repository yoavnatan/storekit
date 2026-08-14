// Drives the "Custom domain" section in the seller settings panel (dashboard.astro #custom-domain).
// AJAX only (no page reload): connect a domain, poll verification, remove it — all via /api/store.
// The local /<slug> path is never touched here; a custom domain is purely additive, so this
// UI can only ever ADD or REMOVE the seller's own domain, never take the store offline.

interface CdResponse {
  ok: boolean;
  error?: string;
  hostname?: string;
  status?: 'pending' | 'active';
  verification?: { cnameTarget: string };
}

function getI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

function cdErrorMessage(i: Record<string, string>, error?: string): string {
  switch (error) {
    case 'invalid-domain': return i.cdInvalid ?? 'Invalid domain.';
    case 'domain-taken':   return i.cdTaken ?? 'This domain is already connected to another store.';
    default:               return i.cdRegisterFailed ?? 'Connection failed, please try again.';
  }
}

export function initCustomDomain(): void {
  const root = document.getElementById('custom-domain');
  if (!root) return;
  const storeId = root.dataset.storeId ?? '';
  const i = getI18n();

  const setup     = document.getElementById('cd-setup') as HTMLElement | null;
  const connected = document.getElementById('cd-connected') as HTMLElement | null;
  const input     = document.getElementById('cd-input') as HTMLInputElement | null;
  const connectBtn = document.getElementById('cd-connect') as HTMLButtonElement | null;
  const hostnameEl = document.getElementById('cd-hostname');
  const badge     = document.getElementById('cd-badge');
  const badgeText = document.getElementById('cd-badge-text');
  const dns       = document.getElementById('cd-dns');
  const primary   = document.getElementById('cd-primary');
  const primaryHost = document.getElementById('cd-primary-host');
  const dnsName   = root.querySelectorAll('#cd-dns code')[1] ?? null; // "Name" row value
  const visitLink = document.getElementById('cd-visit') as HTMLAnchorElement | null;
  const checkBtn  = document.getElementById('cd-check') as HTMLButtonElement | null;
  const removeBtn = document.getElementById('cd-remove') as HTMLButtonElement | null;
  const cnameVal  = document.getElementById('cd-cname-value');
  const msg       = document.getElementById('cd-msg') as HTMLElement | null;
  if (!setup || !connected) return;

  function flash(text: string, isError = false): void {
    if (!msg) return;
    msg.textContent = text;
    msg.className = `text-[0.82rem] mt-3 py-2 px-[.85rem] rounded-[var(--radius)] ${
      isError ? 'bg-[#fef2f2] text-[color:var(--color-danger)] border border-[#fecaca]'
              : 'bg-[#f0fdf4] text-[#166534] border border-[#bbf7d0]'}`;
    msg.hidden = false;
  }

  async function post(action: string, extra: Record<string, string> = {}): Promise<CdResponse> {
    const form = new FormData();
    form.set('_action', action);
    form.set('storeId', storeId);
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    try {
      const res = await fetch('/api/store', { method: 'POST', body: form });
      return await res.json() as CdResponse;
    // silent: the caller turns this into `cdErrorMessage` in the panel.
    } catch { return { ok: false }; }
  }

  // Render the connected panel in either state; keeps DNS instructions + verify button visible only
  // while pending, and reveals the live link + hides "check" once verified.
  function applyStatus(hostname: string, status: 'pending' | 'active'): void {
    const active = status === 'active';
    if (hostnameEl) hostnameEl.textContent = hostname;
    if (dnsName) dnsName.textContent = hostname;
    if (badgeText) badgeText.textContent = active ? (i.cdStatusActive ?? 'Connected') : (i.cdStatusPending ?? 'Pending verification');
    if (badge) badge.className = `inline-flex items-center gap-[.35rem] text-[0.75rem] font-semibold py-[.2rem] px-[.55rem] rounded-full ${
      active ? 'bg-[#f0fdf4] text-[#166534]' : 'bg-[#fffbeb] text-[#92400e]'}`;
    const dot = badge?.querySelector('span');
    if (dot) dot.className = `w-[7px] h-[7px] rounded-full ${active ? 'bg-[#16a34a]' : 'bg-[#d97706]'}`;
    if (dns) dns.hidden = active;
    if (primary) primary.hidden = !active;          // "this is now your primary address" — only once verified
    if (primaryHost) primaryHost.textContent = hostname;
    if (checkBtn) checkBtn.hidden = active;
    if (visitLink) { visitLink.hidden = !active; visitLink.href = `https://${hostname}`; }
    setup!.hidden = true;
    connected!.hidden = false;
  }

  // ── Background auto-verification ── while a domain is pending, poll the provider on an interval so
  // the status flips to green on its own (zero-touch); the manual "check" button stays as a
  // check-now. Skips the network while the tab is hidden, and stops after a cap so an abandoned tab
  // can't poll forever (the manual button + a reload still work past the cap).
  const POLL_INTERVAL = 30_000;
  const MAX_POLL_ATTEMPTS = 60; // ~30 min of active polling
  let pollTimer: number | undefined;
  let pollAttempts = 0;

  function stopPolling(): void {
    if (pollTimer !== undefined) { clearTimeout(pollTimer); pollTimer = undefined; }
  }
  function schedulePoll(): void {
    stopPolling();
    if (pollAttempts >= MAX_POLL_ATTEMPTS) return;
    pollTimer = window.setTimeout(runPoll, POLL_INTERVAL);
  }
  function startPolling(): void {
    pollAttempts = 0;
    schedulePoll();
  }
  async function runPoll(): Promise<void> {
    pollTimer = undefined;
    if (document.hidden) { schedulePoll(); return; } // don't hit the server for a backgrounded tab
    pollAttempts++;
    const data = await post('check-custom-domain');
    if (data.ok && data.status === 'active') {
      applyStatus(hostnameEl?.textContent ?? '', 'active');
      flash(i.cdStatusActive ?? 'Connected');
      stopPolling();
      return;
    }
    schedulePoll();
  }
  // Returning to the tab → check right away instead of waiting out the interval.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && pollTimer !== undefined && pollAttempts < MAX_POLL_ATTEMPTS) {
      stopPolling();
      void runPoll();
    }
  });

  connectBtn?.addEventListener('click', async () => {
    const raw = (input?.value ?? '').trim();
    if (!raw) { input?.focus(); return; }
    connectBtn.disabled = true;
    if (input) input.disabled = true;
    const data = await post('set-custom-domain', { hostname: raw });
    connectBtn.disabled = false;
    if (input) input.disabled = false;
    if (!data.ok || !data.hostname) { flash(cdErrorMessage(i, data.error), true); return; }
    if (cnameVal && data.verification?.cnameTarget) cnameVal.textContent = data.verification.cnameTarget;
    applyStatus(data.hostname, 'pending');
    flash(i.cdPendingNote ?? 'Add the DNS record, then verify.');
    startPolling(); // begin checking in the background — no need for the seller to click
  });

  checkBtn?.addEventListener('click', async () => {
    checkBtn.disabled = true;
    const data = await post('check-custom-domain');
    checkBtn.disabled = false;
    if (!data.ok || !data.status) { flash(cdErrorMessage(i, data.error), true); return; }
    applyStatus(hostnameEl?.textContent ?? '', data.status);
    if (data.status === 'active') { stopPolling(); flash(i.cdStatusActive ?? 'Connected'); }
    else { startPolling(); flash(i.cdStillPending ?? 'Still pending — checking in the background.', true); }
  });

  removeBtn?.addEventListener('click', async () => {
    removeBtn.disabled = true;
    const data = await post('remove-custom-domain');
    removeBtn.disabled = false;
    if (!data.ok) { flash(cdErrorMessage(i, data.error), true); return; }
    stopPolling();
    connected!.hidden = true;
    setup!.hidden = false;
    if (input) input.value = '';
    if (msg) msg.hidden = true;
  });

  // Loaded with a pending domain (e.g. seller added it earlier) → resume background verification.
  if (root.dataset.cdStatus === 'pending') startPolling();

  // The CNAME's copy button is no longer wired here: it is a `CopyButton` like the three
  // address ones added beside it (2026-08-14), handled by copy-value.ts. One copy mechanism
  // on the page, and a tick on the button rather than a flash in the panel's status line —
  // which is where real DNS results are reported, and shouldn't also mean "copied".
}
