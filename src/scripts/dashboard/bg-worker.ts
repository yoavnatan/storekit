import BgWorker from '../../workers/bg-removal?worker';

let _bgWorker: Worker | null = null;
let _msgId = 0;
const _pending = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();

function getBgWorker(): Worker {
  if (!_bgWorker) {
    _bgWorker = new BgWorker();
    _bgWorker.addEventListener('message', (e: MessageEvent) => {
      const { id, success, blob, error } = e.data as { id: number; success: boolean; blob?: Blob; error?: string };
      const cb = _pending.get(id);
      _pending.delete(id);
      if (cb) {
        if (success && blob) cb.resolve(blob);
        else cb.reject(new Error(error ?? 'BG removal failed'));
      }
    });
  }
  return _bgWorker;
}

export function removeBackgroundInWorker(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const id = ++_msgId;
    _pending.set(id, { resolve, reject });
    getBgWorker().postMessage({ id, blob });
  });
}

export function cancelBgWorker(): void {
  if (_bgWorker) { _bgWorker.terminate(); _bgWorker = null; }
  _pending.forEach(({ reject: r }) => r(new Error('cancelled')));
  _pending.clear();
}
