// Branded email shell — the platform's visual language rendered for the inbox.
//
// Email clients strip <style> and ignore CSS variables, so everything is inline
// hex mirrored from tokens.css (kept in one COLORS map to stay honest to the
// design system). RTL + Hebrew, table-based layout for Outlook/Gmail
// compatibility, a text (not image) logo so nothing depends on an external
// asset loading. Content builders (order-emails.ts) fill `bodyHtml`.

import { store } from '../../config/store.config.js';

// Mirror of tokens.css — inline because email clients don't resolve var().
const COLORS = {
  primary: '#2a3547',
  accent: '#4870c0',
  bg: '#f7f8fa',
  surface: '#ffffff',
  text: '#1c2333',
  muted: '#5a6478',
  border: '#e2e5eb',
} as const;

export const emailColors = COLORS;

/** Escape user-supplied strings before interpolating into email HTML — the same
 *  single implementation the site uses (lib/html-escape.ts), re-exported here
 *  under the name the email modules already import. */
import { escapeHtml as esc } from '../html-escape.js';
export { esc };

export interface EmailShellInput {
  /** Inbox-preview snippet (hidden in the body). */
  previewText: string;
  /** Big line at the top of the card. */
  heading: string;
  /** Pre-built, already-escaped inner HTML. */
  bodyHtml: string;
}

export function renderEmailShell({ previewText, heading, bodyHtml }: EmailShellInput): string {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.bg};direction:rtl;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(previewText)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bg};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${COLORS.surface};border:1px solid ${COLORS.border};border-radius:14px;overflow:hidden;font-family:'Heebo',Arial,sans-serif;">
<tr><td style="background:${COLORS.primary};padding:20px 28px;text-align:right;">
<span style="color:${COLORS.surface};font-size:22px;font-weight:800;letter-spacing:-0.5px;">${esc(store.name)}</span>
</td></tr>
<tr><td style="padding:28px 28px 8px;text-align:right;">
<h1 style="margin:0;color:${COLORS.text};font-size:20px;font-weight:700;">${esc(heading)}</h1>
</td></tr>
<tr><td style="padding:8px 28px 28px;color:${COLORS.text};font-size:15px;line-height:1.7;text-align:right;">
${bodyHtml}
</td></tr>
<tr><td style="padding:18px 28px;background:${COLORS.bg};border-top:1px solid ${COLORS.border};text-align:right;">
<p style="margin:0;color:${COLORS.muted};font-size:12px;line-height:1.6;">
${esc(store.name)} · <a href="${esc(store.url)}" style="color:${COLORS.accent};text-decoration:none;">${esc(new URL(store.url).hostname)}</a><br>
© ${year} ${esc(store.business.legalName)}
</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
