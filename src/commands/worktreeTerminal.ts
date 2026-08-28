import * as path from 'node:path';

/** Name + cwd for an integrated terminal opened on a worktree. */
export function worktreeTerminalSpec(
  worktreePath: string,
  branch?: string,
): { name: string; cwd: string } | undefined {
  const raw = worktreePath.trim();
  if (!raw) return undefined;
  const cwd = path.normalize(raw);
  const label = (branch ?? '').trim() || path.basename(cwd);
  return { name: `Git Workflow: ${label}`, cwd };
}
