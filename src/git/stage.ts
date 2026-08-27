import { git } from './exec';

/** Stage path(s) in the worktree (`git add`). */
export async function stagePaths(
  worktreePath: string,
  relativePaths: string[],
): Promise<void> {
  if (relativePaths.length === 0) return;
  await git(worktreePath, ['add', '--', ...relativePaths]);
}

/** Unstage path(s) (`git restore --staged`). */
export async function unstagePaths(
  worktreePath: string,
  relativePaths: string[],
): Promise<void> {
  if (relativePaths.length === 0) return;
  await git(worktreePath, ['restore', '--staged', '--', ...relativePaths]);
}
