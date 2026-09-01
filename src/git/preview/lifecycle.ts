import { git, GitError, gitOk } from '../exec';
import { previewBranch } from './config';
import { forgetChainCache } from './engine';
import { ensurePreviewPushBlocked } from './lanes';
import { resolveBaseSha } from './status';

async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const out = (
      await git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'])
    ).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Enable the overlay on an existing checkout (usually the workspace root):
 * switch it to the preview branch. Requires a clean tree — the caller
 * checks and reports. Returns the branch that was checked out before.
 */
export async function switchToPreviewBranch(
  checkoutPath: string,
  baseRef: string,
  branch = previewBranch(),
): Promise<string | undefined> {
  const previous = await currentBranch(checkoutPath);
  if (
    await gitOk(checkoutPath, ['rev-parse', '--verify', `refs/heads/${branch}`])
  ) {
    try {
      await git(checkoutPath, ['switch', branch]);
    } catch (err) {
      const stderr = err instanceof GitError ? err.stderr : '';
      if (stderr.includes('already used by worktree')) {
        throw new Error(
          `${branch} is already checked out in another worktree — preview mode is on there`,
        );
      }
      throw err;
    }
    await ensurePreviewPushBlocked(checkoutPath);
    return previous;
  }
  const baseSha = await resolveBaseSha(checkoutPath, baseRef);
  if (!baseSha) throw new Error(`base ref ${baseRef} does not resolve`);
  await git(checkoutPath, ['switch', '-c', branch, baseSha]);
  await ensurePreviewPushBlocked(checkoutPath);
  return previous;
}

export interface SwitchAwayResult {
  /** Branch returned to (or a short sha, when it had to detach). */
  branch: string;
  /** Set when that branch was strictly behind origin and was advanced. */
  fastForwarded?: { branch: string; from: string; to: string };
}

/**
 * Disable on a checkout that must stay: leave the preview branch.
 * The tree is derived, so any local state is discarded first.
 *
 * The branch we land on is then fast-forwarded when it is strictly behind
 * origin — see fastForwardBaseBranch. Preview mode leaves the local base
 * untouched for however long it is on, so without this the checkout comes
 * back missing every PR that landed meanwhile.
 */
export async function switchAwayFromPreview(
  checkoutPath: string,
  returnBranch: string | undefined,
  baseRef: string,
  previewBranch: string,
): Promise<SwitchAwayResult> {
  if (await gitOk(checkoutPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']))
    await git(checkoutPath, ['merge', '--abort']).catch(() => {});
  await git(checkoutPath, ['reset', '--hard']);
  const fallback = baseRef.replace(/^origin\//, '');
  for (const target of [returnBranch, fallback]) {
    if (!target || target === previewBranch) continue;
    if (
      await gitOk(checkoutPath, [
        'rev-parse',
        '--verify',
        `refs/heads/${target}`,
      ])
    ) {
      await git(checkoutPath, ['switch', target]);
      return {
        branch: target,
        fastForwarded: await fastForwardBaseBranch(checkoutPath, baseRef),
      };
    }
  }
  // Last resort: detach at base so the checkout leaves the derived branch
  const baseSha = await resolveBaseSha(checkoutPath, baseRef);
  if (!baseSha)
    throw new Error(`no branch to return to and ${baseRef} does not resolve`);
  await git(checkoutPath, ['switch', '--detach', baseSha]);
  return { branch: baseSha.slice(0, 7) };
}

/**
 * Delete the preview branch (disable cleanup). The branch is derived
 * state — lane lists persist separately, so re-enabling loses nothing.
 * Force-delete: the chain's merge commits are reachable from nothing else
 * by design. Best-effort; the branch may not exist.
 */
export async function deletePreviewBranch(
  cwd: string,
  branch = previewBranch(),
): Promise<boolean> {
  // The memoized chain tip is only reachable through this branch. Once it
  // is gone gc may prune it, and a stale sha would be a rebuild built on
  // an object that no longer exists.
  forgetChainCache();
  return gitOk(cwd, ['branch', '-D', branch]);
}

/**
 * After the base changes, the templated branch name may change too
 * (preview/main → preview/staging). Rename the checkout's current
 * branch to match; `git branch -m` carries branch.* config (pushRemote)
 * along. Returns the rename performed, if any.
 */
export async function alignPreviewBranchName(
  checkoutPath: string,
  target = previewBranch(),
): Promise<{ from: string; to: string } | undefined> {
  const current = await currentBranch(checkoutPath);
  if (!current || current === target) return undefined;
  await git(checkoutPath, ['branch', '-m', current, target]);
  return { from: current, to: target };
}

/**
 * Fast-forward the checkout's CURRENT branch to `origin/<base>` when it is
 * strictly behind.
 *
 * The preview builds on resolveBaseSha, which prefers `origin/<base>` — so
 * while preview is on, the local base branch is never advanced by anything
 * and quietly falls behind every landed PR. That is harmless as a ref and
 * alarming as a tree: switching back to it on disable produces a checkout
 * missing fixes that landed weeks ago, which reads as the preview having
 * reverted them.
 *
 * Strictly behind is the whole precondition: local must be an ancestor of
 * the remote, so this can only replay commits that are already published
 * and can drop nothing. Diverged or ahead (unpushed work on the base) is
 * left exactly alone — that is the drift the Preview panel surfaces, and
 * resolving it is the user's call, not a side effect of disabling.
 *
 * Scoped to the branch this checkout HOLDS, so it is a plain `merge
 * --ff-only` in a tree git is willing to validate — never an update-ref
 * behind the back of some other worktree that has the base checked out.
 */
export async function fastForwardBaseBranch(
  checkoutPath: string,
  baseRef: string,
): Promise<{ branch: string; from: string; to: string } | undefined> {
  const name = baseRef.replace(/^origin\//, '');
  const branch = await currentBranch(checkoutPath);
  if (!branch || branch !== name) return undefined;
  const sha = async (ref: string) =>
    (
      await git(checkoutPath, ['rev-parse', '-q', '--verify', ref]).catch(
        () => '',
      )
    ).trim();
  const local = await sha(`refs/heads/${name}`);
  const remote = await sha(`refs/remotes/origin/${name}`);
  if (!local || !remote || local === remote) return undefined;
  if (
    !(await gitOk(checkoutPath, ['merge-base', '--is-ancestor', local, remote]))
  )
    return undefined; // ahead or diverged — never ours to move
  if (!(await gitOk(checkoutPath, ['merge', '--ff-only', remote])))
    return undefined; // untracked collision or a dirty tree — leave it
  return { branch: name, from: local, to: remote };
}
