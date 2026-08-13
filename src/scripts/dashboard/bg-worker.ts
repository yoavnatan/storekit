import BgWorker from '../../workers/bg-removal?worker';

let _bgWorker: Worker | null = null;
let _msgId = 0;
let _warmed = false;
export type BgPhase = 'download' | 'process';
interface Pending { resolve: (b: Blob) => void; reject: (e: Error) => void; onProgress?: (p: number, phase: BgPhase) => void; }
const _pending = new Map<number, Pending>();

/**
 * How long the worker may go SILENT before the job is declared dead — not how long the job may
 * take, and the difference is the whole design.
 *
 * Background removal legitimately runs for minutes on its first use: it downloads a model, and on
 * a phone over cellular that is the slow part. A total-duration timeout would abort exactly the
 * seller having the worst connection, which is the one person it must not fail. But progress ticks
 * arrive throughout BOTH the download and the inference, so silence is a different fact from
 * slowness — ninety seconds without a single tick means nothing is running any more.
 */
const SILENCE_MS = 90_000;

/** Fail every job the worker still owes an answer for, and say the same thing to each. Used by the
 *  three ways a worker can stop existing: a thrown error, an undeliverable message, and going
 *  quiet. */
function failAllPending(reason: string): void {
  const waiting = [..._pending.values()];
  _pending.clear();
  clearSilenceTimer();
  for (const { reject } of waiting) reject(new Error(reason));
}

let _silenceTimer: ReturnType<typeof setTimeout> | undefined;
function clearSilenceTimer(): void {
  if (_silenceTimer !== undefined) { clearTimeout(_silenceTimer); _silenceTimer = undefined; }
}
/** Restarted on every message, so a job that is making progress is never interrupted. */
function armSilenceTimer(): void {
  clearSilenceTimer();
  if (_pending.size === 0) return;
  _silenceTimer = setTimeout(() => {
    // The worker is gone or wedged; a fresh one is the only way back, and terminating it also
    // releases the model's memory — which is what a crash on a weak device was short of.
    _bgWorker?.terminate();
    _bgWorker = null;
    _warmed = false;
    failAllPending('BG removal stopped responding');
  }, SILENCE_MS);
}

function getBgWorker(): Worker {
  if (!_bgWorker) {
    _bgWorker = new BgWorker();
    _bgWorker.addEventListener('message', (e: MessageEvent) => {
      const { id, success, blob, error, progress, phase } = e.data as
        { id: number; success?: boolean; blob?: Blob; error?: string; progress?: number; phase?: BgPhase };
      const cb = _pending.get(id);
      if (!cb) return;
      // Progress ticks arrive repeatedly before the final result — forward, keep pending open.
      if (typeof progress === 'number') { cb.onProgress?.(progress, phase ?? 'process'); armSilenceTimer(); return; }
      _pending.delete(id);
      if (success && blob) cb.resolve(blob);
      else cb.reject(new Error(error ?? 'BG removal failed'));
      armSilenceTimer();
    });
    // **The listener that was missing, and the reason the button could spin forever.** Every path
    // above assumes the worker answers. A worker that THROWS during startup — or that the browser
    // kills, which is what an out-of-memory model load looks like on a weak phone — posts no
    // message at all, so the promise never settled, the busy button never came back, and the seller
    // was left with a control that had simply stopped being a control. `error` covers an uncaught
    // throw inside it; `messageerror` covers a reply that could not be deserialised.
    _bgWorker.addEventListener('error', () => failAllPending('BG removal failed to start'));
    _bgWorker.addEventListener('messageerror', () => failAllPending('BG removal failed'));
  }
  return _bgWorker;
}

export function removeBackgroundInWorker(blob: Blob, onProgress?: (p: number, phase: BgPhase) => void): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const id = ++_msgId;
    _pending.set(id, { resolve, reject, onProgress });
    getBgWorker().postMessage({ id, blob });
    // Armed only once there is something to wait for, and re-armed on every reply — see SILENCE_MS.
    armSilenceTimer();
  });
}

// Kicks off the (large, one-time) model download + init in the background so the first real
// removal doesn't pay for it at click time. Safe to call repeatedly — only fires once.
export function warmBgWorker(): void {
  if (_warmed) return;
  _warmed = true;
  getBgWorker().postMessage({ id: 0, preload: true });
}

export function cancelBgWorker(): void {
  if (_bgWorker) { _bgWorker.terminate(); _bgWorker = null; }
  _warmed = false;
  failAllPending('cancelled');
}
