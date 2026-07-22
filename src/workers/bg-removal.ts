import { segmentForeground, applySegmentationMask, preload, type Config } from '@imgly/background-removal';

// isnet_fp16 is the quality/size sweet spot — markedly cleaner edges on busy/coloured
// backgrounds than the heavily-quantised isnet_quint8 we used before, at ~half the size of
// the full isnet. WebGPU (when the browser exposes it, even inside a worker) runs inference
// an order of magnitude faster than the WASM/CPU path; we fall back to cpu when it's absent
// or fails to initialise. `preferredDevice` sticks to cpu for the rest of the session once a
// GPU attempt has thrown, so we don't re-pay a failing GPU init on every image.
const MODEL = 'isnet_fp16' as const;
let preferredDevice: 'gpu' | 'cpu' =
  typeof (self as unknown as { navigator?: { gpu?: unknown } }).navigator?.gpu !== 'undefined' &&
  (self as unknown as { navigator?: { gpu?: unknown } }).navigator?.gpu
    ? 'gpu'
    : 'cpu';

function baseConfig(progress?: Config['progress']): Config {
  return { model: MODEL, device: preferredDevice, progress };
}

async function resizeBlob(blob: Blob, maxPx: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const scale = Math.min(1, maxPx / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

// Runs segmentation, transparently retrying on cpu once if a gpu attempt fails to init.
async function segment(blob: Blob, progress?: Config['progress']): Promise<Blob> {
  try {
    return await segmentForeground(blob, baseConfig(progress));
  } catch (err) {
    if (preferredDevice === 'gpu') {
      preferredDevice = 'cpu';
      return await segmentForeground(blob, baseConfig(progress));
    }
    throw err;
  }
}

self.addEventListener('message', async (e: MessageEvent<{ id: number; blob?: Blob; preload?: boolean }>) => {
  const { id, blob, preload: warm } = e.data;
  // Warm-up: download + initialise the model ahead of the first real request so the seller
  // doesn't wait for the (large, one-time) model download at click time.
  if (warm) {
    try { await preload(baseConfig()); } catch { /* best-effort, ignore */ }
    return;
  }
  if (!blob) return;
  try {
    // Run the (expensive) ML segmentation on a downsized copy for speed, but apply the
    // resulting mask back onto the original full-resolution blob — applySegmentationMask
    // upscales the mask internally, so the final cutout keeps the source image's quality
    // instead of being capped at the 1024px working resolution.
    const small = await resizeBlob(blob, 1024);
    // The library reports two distinct phases via the key: `fetch:*` while downloading the
    // (one-time, then cached) model files, and `compute:*` (0..4 steps) during the actual
    // removal. They're forwarded as separate phases so the UI doesn't show one bar filling to
    // 100% twice — the download is labelled on its own, the removal gets the clean percentage.
    const mask = await segment(small, (key, current, total) => {
      const phase = key.startsWith('fetch') ? 'download' : 'process';
      self.postMessage({ id, phase, progress: total > 0 ? current / total : 0 });
    });
    const result = await applySegmentationMask(blob, mask, baseConfig());
    self.postMessage({ id, success: true, blob: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'BG removal failed';
    self.postMessage({ id, success: false, error: msg });
  }
});
