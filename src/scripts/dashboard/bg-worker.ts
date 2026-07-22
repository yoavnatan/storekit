import BgWorker from '../../workers/bg-removal?worker';

let _bgWorker: Worker | null = null;
let _msgId = 0;
let _warmed = false;
export type BgPhase = 'download' | 'process';
interface Pending { resolve: (b: Blob) => void; reject: (e: Error) => void; onProgress?: (p: number, phase: BgPhase) => void; }
const _pending = new Map<number, Pending>();

function getBgWorker(): Worker {
  if (!_bgWorker) {
    _bgWorker = new BgWorker();
    _bgWorker.addEventListener('message', (e: MessageEvent) => {
      const { id, success, blob, error, progress, phase } = e.data as
        { id: number; success?: boolean; blob?: Blob; error?: string; progress?: number; phase?: BgPhase };
      const cb = _pending.get(id);
      if (!cb) return;
      // Progress ticks arrive repeatedly before the final result — forward, keep pending open.
      if (typeof progress === 'number') { cb.onProgress?.(progress, phase ?? 'process'); return; }
      _pending.delete(id);
      if (success && blob) cb.resolve(blob);
      else cb.reject(new Error(error ?? 'BG removal failed'));
    });
  }
  return _bgWorker;
}

export function removeBackgroundInWorker(blob: Blob, onProgress?: (p: number, phase: BgPhase) => void): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const id = ++_msgId;
    _pending.set(id, { resolve, reject, onProgress });
    getBgWorker().postMessage({ id, blob });
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
  _pending.forEach(({ reject: r }) => r(new Error('cancelled')));
  _pending.clear();
}
