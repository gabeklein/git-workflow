import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ensureExcludedFromStatus } from '../exclude';
import { git, GitError, gitOk } from '../exec';
import { integrationBranch } from './config';
import { forgetChainCache } from './engine';
import { ensureIntegrationPushBlocked } from './lanes';
import { resolveBaseSha } from './status';

export async function createIntegrationWorktree(
  repoCwd: string,
  destDir: string,
  baseRef: string,
  branch = integrationBranch(),
): Promise<void> {
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  // Repo-local ignore before creation, so status never flashes dirty
  await ensureExcludedFromStatus(destDir).catch(() => undefined);
  if (await gitOk(repoCwd, ['rev-parse', '--verify', `refs/heads/${branch}`])) {
    await git(repoCwd, ['worktree', 'add', destDir, branch]);
  } else {
    const baseSha = await resolveBaseSha(repoCwd, baseRef);
    if (!baseSha) {
      throw new Error(`base ref ${baseRef} does not resolve`);
    }
    await git(repoCwd, ['worktree', 'add', '-b', branch, destDir, baseSha]);
  }
  await ensureIntegrationPushBlocked(repoCwd);
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
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
 * switch it to the integration branch. Requires a clean tree — the caller
 * checks and reports. Returns the branch that was checked out before.
 */
export async function switchToIntegrationBranch(
  checkoutPath: string,
  baseRef: string,
  branch = integrationBranch(),
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
          `${branch} is already checked out in another worktree — integration mode is on there`,
        );
      }
      throw err;
    }
    await ensureIntegrationPushBlocked(checkoutPath);
    return previous;
  }
  const baseSha = await resolveBaseSha(checkoutPath, baseRef);
  if (!baseSha) {
    throw new Error(`base ref ${baseRef} does not resolve`);
  }
  await git(checkoutPath, ['switch', '-c', branch, baseSha]);
  await ensureIntegrationPushBlocked(checkoutPath);
  return previous;
}

/**
 * Disable on a checkout that must stay: leave the integration branch.
 * The tree is derived, so any local state is discarded first.
 */
export async function switchAwayFromIntegration(
  checkoutPath: string,
  returnBranch: string | undefined,
  baseRef: string,
  previewBranch = integrationBranch(),
): Promise<string> {
  if (await gitOk(checkoutPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
    await git(checkoutPath, ['merge', '--abort']).catch(() => {});
  }
  await git(checkoutPath, ['reset', '--hard']);
  const fallback = baseRef.replace(/^origin\//, '');
  for (const target of [returnBranch, fallback]) {
    if (!target || target === previewBranch) {
      continue;
    }
    if (
      await gitOk(checkoutPath, [
        'rev-parse',
        '--verify',
        `refs/heads/${target}`,
      ])
    ) {
      await git(checkoutPath, ['switch', target]);
      return target;
    }
  }
  // Last resort: detach at base so the checkout leaves the derived branch
  const baseSha = await resolveBaseSha(checkoutPath, baseRef);
  if (!baseSha) {
    throw new Error(`no branch to return to and ${baseRef} does not resolve`);
  }
  await git(checkoutPath, ['switch', '--detach', baseSha]);
  return baseSha.slice(0, 7);
}

/**
 * Delete the integration branch (disable cleanup). The branch is derived
 * state — lane lists persist separately, so re-enabling loses nothing.
 * Force-delete: the chain's merge commits are reachable from nothing else
 * by design. Best-effort; the branch may not exist.
 */
export async function deleteIntegrationBranch(
  cwd: string,
  branch = integrationBranch(),
): Promise<boolean> {
  // The memoized chain tip is only reachable through this branch. Once it
  // is gone gc may prune it, and a stale sha would be a rebuild built on
  // an object that no longer exists.
  forgetChainCache();
  return gitOk(cwd, ['branch', '-D', branch]);
}

/**
 * After the base changes, the templated branch name may change too
 * (integration/main → integration/staging). Rename the checkout's current
 * branch to match; `git branch -m` carries branch.* config (pushRemote)
 * along. Returns the rename performed, if any.
 */
export async function alignIntegrationBranchName(
  checkoutPath: string,
  target = integrationBranch(),
): Promise<{ from: string; to: string } | undefined> {
  const current = await currentBranch(checkoutPath);
  if (!current || current === target) {
    return undefined;
  }
  await git(checkoutPath, ['branch', '-m', current, target]);
  return { from: current, to: target };
}
