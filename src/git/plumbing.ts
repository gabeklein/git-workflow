import { git, GitError } from './exec';

/**
 * Small shared git plumbing used across domains — one definition each for
 * checks whose semantics must stay identical everywhere.
 */

/** Uncommitted changes in a working tree (untracked counted, submodule
 *  content churn ignored) — THE dirtiness definition for every caller. */
export async function isWorktreeDirty(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, [
      'status',
      '--porcelain=v1',
      '-unormal',
      '--ignore-submodules=dirty',
    ]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Commit sha for a ref, or undefined when it does not resolve. */
export async function revParseCommit(
  cwd: string,
  ref: string,
): Promise<string | undefined> {
  try {
    return (
      await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])
    ).trim();
  } catch {
    return undefined;
  }
}

/** Best human-readable message from a git failure. */
export function gitErrorMessage(err: unknown): string {
  if (err instanceof GitError) return err.stderr.trim() || err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Files a checkout holds that git ignores — invisible to isWorktreeDirty,
 * and deleted without complaint by `git worktree remove`. Untracked files
 * make remove refuse on their own; ignored ones do not, so this is the
 * only warning a caller can give before they go.
 */
export async function ignoredFiles(dir: string): Promise<string[]> {
  try {
    const out = await git(dir, [
      'status',
      '--porcelain=v1',
      '-z',
      '--ignored=matching',
      '-unormal',
    ]);
    return out
      .split('\0')
      .filter((entry) => entry.startsWith('!! '))
      .map((entry) => entry.slice(3));
  } catch {
    return [];
  }
}
