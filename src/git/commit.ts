import { git } from './exec';
import { stagePaths } from './stage';

/**
 * Commit currently staged changes only (`git commit`).
 * Does not auto-stage unstaged files.
 */
export async function commitStaged(
  worktreePath: string,
  message: string,
): Promise<void> {
  const msg = message.trim();
  if (!msg) {
    throw new Error('Commit message is required');
  }
  await git(worktreePath, ['commit', '-m', msg]);
}

/**
 * Stage the given relative paths (or all if empty via `git add -A`) then commit.
 * Intended when the index is clean and only unstaged/untracked work remains.
 */
export async function commitUnstagedPaths(
  worktreePath: string,
  relativePaths: string[],
  message: string,
): Promise<void> {
  const msg = message.trim();
  if (!msg) {
    throw new Error('Commit message is required');
  }
  if (relativePaths.length === 0) {
    await git(worktreePath, ['add', '-A']);
  } else {
    await stagePaths(worktreePath, relativePaths);
  }
  await git(worktreePath, ['commit', '-m', msg]);
}
