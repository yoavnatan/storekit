import { removeBackground } from '@imgly/background-removal';

self.addEventListener('message', async (e: MessageEvent<{ id: number; blob: Blob }>) => {
  const { id, blob } = e.data;
  try {
    const result = await removeBackground(blob);
    self.postMessage({ id, success: true, blob: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'BG removal failed';
    self.postMessage({ id, success: false, error: msg });
  }
});
