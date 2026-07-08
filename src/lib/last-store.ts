const KEY = 'last_store_v1';

export interface LastStore {
  slug: string;
  name: string;
  url: string;
}

export function saveLastStore(store: LastStore): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(store)); } catch {}
}

export function getLastStore(): LastStore | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LastStore) : null;
  } catch {
    return null;
  }
}

export function clearLastStore(): void {
  try { sessionStorage.removeItem(KEY); } catch {}
}
