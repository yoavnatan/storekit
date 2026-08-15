/**
 * The one place a developer script shells out to a command on the PATH.
 *
 * It lived in `worktree-setup.mjs` and moved here the day a second script needed it
 * (`audit-drift.mjs`, 2026-08-16). The move is the point: `sonarjs/no-os-command-from-path` is
 * suppressed on exactly one line in this repo, and the standing rule is that the suppression count
 * may only ever go DOWN. A second copy would have been a second line to disbelieve — and the next
 * script after that a third — so the helper moved instead of the comment being duplicated.
 *
 * `stdio: 'pipe'` by default because most callers read the output; pass `stdio: 'inherit'` for the
 * ones that want the child's console instead (npm ci, a warm-up verify), which makes execFileSync
 * return null — hence the `?? ''`.
 *
 * Scripts only. Nothing under `src/` may import this: the app never runs a shell command, and the
 * day it wants to is the day this rule is worth having.
 */
import { execFileSync } from 'node:child_process';

export const run = (cmd, args, opts = {}) =>
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts })?.trim() ?? '';

/** `git` with the arguments spread, since every caller so far is one. */
export const git = (...args) => run('git', args);
