// Google sign-in configuration, in one place.
//
// Four surfaces need to agree on it: the start route (/api/auth/google), the callback, and the
// seller login + register pages, which have to decide whether to render the button at all. They
// didn't: the pages rendered "המשך עם Google" unconditionally while the route answered a bare
// `503 Google OAuth not configured` — and since GOOGLE_CLIENT_ID has never been set, that was
// the live behaviour of the most prominent button on the login page. Two routes reading the same
// three variables inline, with no way for a page to ask, is the shape that produced it.
import { serverEnv } from './runtime-env.js';

export function googleClientId(): string | undefined {
  return serverEnv('GOOGLE_CLIENT_ID');
}

export function googleClientSecret(): string | undefined {
  return serverEnv('GOOGLE_CLIENT_SECRET');
}

/**
 * Whether the flow can actually complete end to end. Both halves are required, not just the
 * client id: with an id but no secret the button would hand the seller to Google and then fail
 * on the way back, which is worse than not offering it.
 */
export function isGoogleAuthEnabled(): boolean {
  return Boolean(googleClientId() && googleClientSecret());
}

/**
 * The redirect URI, which must match one registered in the Google console. Defaults to this
 * app's own callback on the requesting origin so localhost and production both work with no
 * configuration; GOOGLE_REDIRECT_URI overrides it (e.g. behind a proxy that rewrites the host).
 */
export function googleRedirectUri(origin: string): string {
  return serverEnv('GOOGLE_REDIRECT_URI') || `${origin}/api/auth/google/callback`;
}
