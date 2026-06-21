import { removeBackground } from '@imgly/background-removal';

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

self.addEventListener('message', async (e: MessageEvent<{ id: number; blob: Blob }>) => {
  const { id, blob } = e.data;
  try {
    const resized = await resizeBlob(blob, 1024);
    const result = await removeBackground(resized, { model: 'isnet_quint8' });
    self.postMessage({ id, success: true, blob: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'BG removal failed';
    self.postMessage({ id, success: false, error: msg });
  }
});
