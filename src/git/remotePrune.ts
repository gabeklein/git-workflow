import { git, gitOk } from './exec';

/**
 * Remote-tracking refs for branches the remote no longer has.
 *
 * `refs/remotes/origin/*` is a cache of what origin had the last time
 * anything fetched, and nothing in git removes an entry on its own: every
 * fetch here is a targeted refspec (cheap, and deliberately so), and
 * `git pull` does not prune unless `fetch.prune` is set. So a branch
 * deleted on the remote — which is what a merged PR does by default —
 * leaves a tracking ref behind FOREVER.
 *
 * The Remote group then lists a branch that does not exist, with no way to
 * tell it from one that does. Measured on this repo: seven ghosts, one per
 * merged PR, and the row for the branch you just landed is the one you are
 * most likely to be looking at.
 *
 * It is also read as evidence elsewhere — the prune flow says which
 * branches "origin still has" — so a stale ref does not just show a wrong
 * row, it weakens a safety check.
 *
 * Pruning deletes nothing but the cache entry: the next fetch recreates it
 * if the branch is really there, and no local branch, commit or worktree is
 * touched. That is what makes it safe to do automatically.
 */

/** Names of stale tracking refs, without asking the remote. */
export async function staleTrackingRefs(cwd: string): Promise<string[]> {
  // --dry-run still contacts the remote, so this is not a local-only
  // question; it just does not write anything.
  const out = await git(cwd, ['remote', 'prune', '--dry-run', 'origin']).catch(
    () => '',
  );
  return parsePruneOutput(out);
}

/**
 * Drop stale tracking refs. Returns the names dropped, empty when there
 * were none or the remote could not be reached — offline is not an event
 * worth reporting on a background tick.
 */
export async function pruneTrackingRefs(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['remote', 'prune', 'origin']).catch(() => '');
  return parsePruneOutput(out);
}

/** Is there an `origin` to prune at all? */
export function hasOrigin(cwd: string): Promise<boolean> {
  return gitOk(cwd, ['remote', 'get-url', 'origin']);
}

/**
 * `git remote prune` writes a header, a URL line, then one ` * [pruned]
 * origin/<name>` (or `[would prune]`) per ref. Only the marker lines are
 * data, and the marker differs between dry-run and the real thing.
 */
export function parsePruneOutput(out: string): string[] {
  const names: string[] = [];
  for (const line of out.split('\n')) {
    const match = /^\s*\*\s*\[(?:pruned|would prune)\]\s*(\S+)\s*$/.exec(line);
    if (!match?.[1]) continue;
    names.push(match[1].replace(/^origin\//, ''));
  }
  return names;
}
