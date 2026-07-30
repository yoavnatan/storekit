import { describe, it, expect } from 'vitest';
import { isBotUserAgent, isBotRequest } from '../src/lib/bot-detect.js';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

describe('isBotUserAgent', () => {
  it('lets real shoppers through', () => {
    for (const ua of [CHROME, IPHONE, ANDROID]) expect(isBotUserAgent(ua)).toBe(false);
  });

  it('does not mistake the CUBOT phone brand for a bot', () => {
    // The reason the generic rule needs a trailing word boundary: these are real
    // Android devices, and misreading them as crawlers would silently drop a
    // slice of genuine mobile traffic out of every seller's numbers.
    expect(isBotUserAgent('Mozilla/5.0 (Linux; Android 9; CUBOT_X19 Build/PPR1) Mobile Safari/537.36')).toBe(false);
    expect(isBotUserAgent('Mozilla/5.0 (Linux; Android 11; CUBOT_NOTE_20) Chrome/126 Mobile Safari/537.36')).toBe(false);
  });

  it('catches every crawler robots.txt invites', () => {
    const robots = fs.readFileSync(path.join(process.cwd(), 'public/robots.txt'), 'utf8');
    const agents = [...robots.matchAll(/^User-agent:\s*(.+)$/gim)]
      .map((m) => m[1].trim())
      .filter((a) => a !== '*');
    expect(agents.length).toBeGreaterThan(5); // the list is real, not an empty pass
    for (const agent of agents) {
      expect(isBotUserAgent(`${agent}/1.0 (+https://example.com/bot.html)`), agent).toBe(true);
    }
  });

  it('catches search engines, previewers, monitors and bare HTTP clients', () => {
    const bots = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 (compatible; YandexBot/3.0)',
      'facebookexternalhit/1.1',
      'WhatsApp/2.23.20.0',
      'Slackbot-LinkExpanding 1.0',
      'curl/8.4.0',
      'python-requests/2.31.0',
      'Go-http-client/2.0',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) Chrome-Lighthouse',
      'Mozilla/5.0 (compatible; SomeBrandNewBot/1.0; +https://example.com)',
    ];
    for (const ua of bots) expect(isBotUserAgent(ua), ua).toBe(true);
  });

  it('treats a missing or empty User-Agent as automated', () => {
    // Every real browser sends one; a request without it is a script.
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent('')).toBe(true);
  });

  it('reads the header off a Request', () => {
    expect(isBotRequest(new Request('https://x.test', { headers: { 'user-agent': CHROME } }))).toBe(false);
    expect(isBotRequest(new Request('https://x.test', { headers: { 'user-agent': 'GPTBot/1.2' } }))).toBe(true);
  });
});
