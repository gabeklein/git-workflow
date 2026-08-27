import { git, gitOk } from './exec';
import { gitErrorMessage } from './plumbing';

/**
 * Reconciling ONE branch with its own upstream — not with the base.
 *
 * That distinction is the whole design. Catch Up brings a lane up to date
 * with `main`, where being ahead is the normal, expected state, so
 * catchUpStrategy can reasonably choose rebase. Sync compares a branch to
 * `origin/<same-branch>`, where divergence is not routine: it means
 * someone else, another machine, or an agent pushed to this branch, or
 * history was rewritten locally.
 *
 * So the strategies do NOT transfer. In a diverged sync the branch is by
 * definition published, which makes 'auto' collapse to always-merge — a
 * merge commit on the feature branch itself, in the PR diff — and makes
 * 'rebase' a force-push over commits somebody else may have put on origin.
 * That is the standard way pushed work disappears, and nothing else in
 * this extension rewrites published history without being asked
 * (autoRebaseLanes is local-only for the same reason).
 *
 * Hence: the two unambiguous directions happen silently, an unpublished
 * branch gets published, and the ambiguous case REFUSES and names the tool
 * built for it. A context menu is not the place to guess.
 */

export type SyncResult =
  | { status: 'up-to-date' }
  | { status: 'published'; branch: string }
  | { status: 'fast-forwarded'; behind: number }
  | { status: 'pushed'; ahead: number }
  | { status: 'diverged'; ahead: number; behind: number }
  | { status: 'no-remote' }
  | { status: 'blocked' | 'error'; message: string };

async function counts(
  cwd: string,
  branch: string,
): Promise<{ ahead: number; behind: number } | undefined> {
  try {
    const out = await git(cwd, [
      'rev-list',
      '--left-right',
      '--count',
      `refs/remotes/origin/${branch}...refs/heads/${branch}`,
    ]);
    const [behindRaw, aheadRaw] = out.trim().split(/\s+/);
    return { ahead: Number(aheadRaw) || 0, behind: Number(behindRaw) || 0 };
  } catch {
    return undefined;
  }
}

/**
 * Fetch, compare, and move whichever side can move without a decision.
 *
 * `worktree` is the checkout holding the branch, when one does. It matters
 * because the two ways to fast-forward are mutually exclusive: a
 * checked-out branch has to be moved by merging inside its own worktree,
 * and `fetch origin b:b` refuses outright; a branch with no checkout can
 * only be moved by the fetch, since there is no tree to merge in.
 */
export async function syncBranchWithRemote(
  repoCwd: string,
  branch: string,
  worktree?: string,
): Promise<SyncResult> {
  if (!branch || branch === 'HEAD') {
    return { status: 'blocked', message: 'not on a branch' };
  }
  try {
    // Targeted refspec: cheap, and it updates the remote-tracking ref the
    // comparison below reads. A branch absent from origin fails here, which
    // is the unpublished case rather than an error.
    const onRemote = await gitOk(repoCwd, [
      'fetch',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    if (!onRemote) {
      if (!(await gitOk(repoCwd, ['remote', 'get-url', 'origin']))) {
        return { status: 'no-remote' };
      }
      await git(repoCwd, ['push', '-u', 'origin', branch]);
      return { status: 'published', branch };
    }
    const count = await counts(repoCwd, branch);
    if (!count) {
      return { status: 'error', message: 'could not compare with origin' };
    }
    const { ahead, behind } = count;
    if (ahead === 0 && behind === 0) {
      return { status: 'up-to-date' };
    }
    if (ahead > 0 && behind > 0) {
      // The only case with a real decision in it, and the one where a wrong
      // guess costs somebody their commits.
      return { status: 'diverged', ahead, behind };
    }
    if (behind > 0) {
      if (worktree) {
        // --ff-only: refuses rather than inventing a merge commit, and git
        // stops on its own if this would clobber uncommitted work.
        await git(worktree, [
          'merge',
          '--ff-only',
          `refs/remotes/origin/${branch}`,
        ]);
      } else {
        await git(repoCwd, [
          'fetch',
          'origin',
          `refs/heads/${branch}:refs/heads/${branch}`,
        ]);
      }
      return { status: 'fast-forwarded', behind };
    }
    await git(repoCwd, ['push', 'origin', branch]);
    return { status: 'pushed', ahead };
  } catch (err) {
    return { status: 'error', message: gitErrorMessage(err) };
  }
}
