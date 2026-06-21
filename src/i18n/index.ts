import type { AstroCookies } from 'astro';
import { translations, type Lang } from './translations';

export type { Lang };
export { translations };

export function getLang(cookies: AstroCookies): Lang {
  const v = cookies.get('lang')?.value;
  return v === 'en' ? 'en' : 'he';
}

export function getDir(lang: Lang): 'rtl' | 'ltr' {
  return lang === 'he' ? 'rtl' : 'ltr';
}

export function getT(lang: Lang) {
  return translations[lang];
}
