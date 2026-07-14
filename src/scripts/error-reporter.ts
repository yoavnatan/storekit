const MAX_REPORTS_PER_SESSION = 5;
let reportCount = 0;

function report(message: string, stack?: string): void {
  if (reportCount >= MAX_REPORTS_PER_SESSION) return;
  reportCount++;
  fetch('/api/log-client-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, stack, route: window.location.pathname }),
    keepalive: true,
  }).catch(() => {});
}

export function initErrorReporter(): void {
  window.addEventListener('error', (e) => {
    report(e.message, e.error?.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    report(message, stack);
  });
}
