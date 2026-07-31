// Drives the "Store activity" section in the seller settings panel (dashboard.astro
// #lifecycle-section): stop selling, reopen, close. AJAX only — the section re-renders itself
// from the API's answer, no page reload.
//
// The one thing worth knowing here: "close" is not a request that can be REFUSED. If orders are
// still open the server pauses the store and leaves the closure pending, and answers
// state:'closing' — so the UI has to be able to render that third state, not just active/paused.
// See lib/store-lifecycle.ts.
import { showErrorToast, showToast } from '../../lib/toast.js';

type LifecycleState = 'active' | 'paused' | 'closing' | 'closed' | 'blocked';

interface LifecycleResponse {
  ok: boolean;
  error?: string;
  state?: LifecycleState;
  openOrders?: number;
}

function getI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

export function initStoreLifecycle(): void {
  const root = document.getElementById('lifecycle-section');
  if (!root) return;
  const storeId = root.dataset['storeId'] ?? '';
  const i = getI18n();

  const stateEl  = document.getElementById('lc-state');
  const noteEl   = document.getElementById('lc-note');
  const ordersEl = document.getElementById('lc-open-orders');
  const pauseBtn  = document.getElementById('lc-pause')  as HTMLButtonElement | null;
  const resumeBtn = document.getElementById('lc-resume') as HTMLButtonElement | null;
  const closeBtn  = document.getElementById('lc-close')  as HTMLButtonElement | null;

  function render(state: LifecycleState, openOrders: number): void {
    root!.dataset['state'] = state;
    root!.dataset['openOrders'] = String(openOrders);

    if (stateEl) {
      stateEl.textContent =
        state === 'paused'  ? (i.lcStatePaused ?? '')
        : state === 'closing' ? (i.lcStateClosing ?? '')
        : state === 'closed'  ? (i.lcStateClosed ?? '')
        : state === 'blocked' ? (i.lcStateBlocked ?? '')
        : (i.lcStateActive ?? '');
    }
    if (noteEl) {
      noteEl.textContent =
        state === 'paused'  ? (i.lcPausedNote ?? '')
        : state === 'closing' ? (i.lcClosingNote ?? '')
        : state === 'closed'  ? (i.lcClosedNote ?? '')
        : state === 'blocked' ? ''
        : (i.lcActiveNote ?? '');
    }
    if (ordersEl) {
      ordersEl.textContent = (i.lcOpenOrders ?? '').replace('{n}', String(openOrders));
      ordersEl.hidden = openOrders === 0;
    }
    if (pauseBtn)  pauseBtn.hidden  = state !== 'active';
    if (resumeBtn) {
      resumeBtn.hidden = state !== 'paused' && state !== 'closing';
      // One button, two sentences: from `closing` it undoes the closure, from `paused` it just
      // reopens. They are the same server action (resume clears both flags), so a second button
      // would only be a second thing to keep in step with this one.
      resumeBtn.textContent = state === 'closing' ? (i.lcCancelClose ?? '') : (i.lcResume ?? '');
    }
    if (closeBtn) closeBtn.hidden = state !== 'active' && state !== 'paused';
  }

  async function send(action: 'pause' | 'resume' | 'close'): Promise<void> {
    for (const btn of [pauseBtn, resumeBtn, closeBtn]) if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/seller/store-lifecycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, storeId }),
      });
      const data = await res.json().catch(() => null) as LifecycleResponse | null;
      if (!res.ok || !data?.ok || !data.state) {
        showErrorToast(data?.error || (i.lcFailed ?? 'Action failed.'));
        return;
      }
      render(data.state, data.openOrders ?? 0);
      // Say it out loud when the store comes BACK. Pausing and closing announce
      // themselves — the page fills with a halted notice — but reopening only
      // undoes that, and an undo that leaves no trace reads as "did that work?".
      // Gated on the state the SERVER returned, not the one we asked for.
      if (action === 'resume' && data.state === 'active') showToast(i.lcResumedToast ?? '');
    } catch {
      showErrorToast(i.lcFailed ?? 'Action failed.');
    } finally {
      for (const btn of [pauseBtn, resumeBtn, closeBtn]) if (btn) btn.disabled = false;
    }
  }

  /** Every one of the three actions confirms first, through the shared modal — never a native
   *  `confirm()` (AI_INSTRUCTIONS → Micro-interactions). `tone` is what keeps them apart: pause
   *  and close take away, so they keep the modal's red OK; reopening puts the store back, so it
   *  asks in the ordinary primary colour (owner, 2026-07-31). Same dialog, opposite meaning. */
  function confirmThen(title: string, message: string, okLabel: string, tone: 'danger' | 'primary', run: () => void): void {
    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: { title, message, okLabel, tone, onConfirm: run },
    }));
  }

  pauseBtn?.addEventListener('click', () => {
    confirmThen(i.lcPauseConfirmTitle ?? '', i.lcPauseConfirmBody ?? '', i.lcPause ?? '', 'danger', () => void send('pause'));
  });
  // Reopening is one server action but two different sentences — the button reads "reopen" from
  // `paused` and "call off the closure" from `closing`, so the dialog has to say whichever one
  // the seller actually clicked. Read off the section's live state, the same value render() writes.
  resumeBtn?.addEventListener('click', () => {
    const undoingClosure = root.dataset['state'] === 'closing';
    confirmThen(
      (undoingClosure ? i.lcCancelCloseConfirmTitle : i.lcResumeConfirmTitle) ?? '',
      (undoingClosure ? i.lcCancelCloseConfirmBody : i.lcResumeConfirmBody) ?? '',
      (undoingClosure ? i.lcCancelClose : i.lcResume) ?? '',
      'primary',
      () => void send('resume'),
    );
  });
  closeBtn?.addEventListener('click', () => {
    confirmThen(i.lcCloseConfirmTitle ?? '', i.lcCloseConfirmBody ?? '', i.lcClose ?? '', 'danger', () => void send('close'));
  });
}
