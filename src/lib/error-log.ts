import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ERROR_LOG_PATH = path.join(process.cwd(), 'data/error-log.json');
const MAX_ENTRIES = 500;

export interface ErrorLogEntry {
  id: string;
  source: 'server' | 'client';
  route?: string;
  message: string;
  stack?: string;
  statusCode?: number;
  createdAt: string;
}

function readErrorLog(): ErrorLogEntry[] {
  try { return JSON.parse(fs.readFileSync(ERROR_LOG_PATH, 'utf8')) as ErrorLogEntry[]; }
  catch { return []; }
}

function writeErrorLog(entries: ErrorLogEntry[]): void {
  fs.writeFileSync(ERROR_LOG_PATH, JSON.stringify(entries, null, 2));
}

export function truncateStack(stack: string, max = 2000): string {
  return stack.length > max ? stack.slice(0, max) + '…' : stack;
}

// Fire-and-forget by design: a logging failure must never break the request
// that triggered it, so every error here is swallowed rather than thrown.
export function logError(entry: Omit<ErrorLogEntry, 'id' | 'createdAt'>): void {
  try {
    const entries = readErrorLog();
    entries.push({
      ...entry,
      stack: entry.stack ? truncateStack(entry.stack) : undefined,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    // Cap the file so a noisy repeating error can't grow it unbounded —
    // drop the oldest entries first, keep the most recent MAX_ENTRIES.
    writeErrorLog(entries.slice(-MAX_ENTRIES));
  } catch { /* logging must never itself throw */ }
}

export function getRecentErrors(limit = 100): ErrorLogEntry[] {
  return readErrorLog()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

export function clearErrorLog(): void {
  writeErrorLog([]);
}
