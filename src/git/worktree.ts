import * as path from 'node:path';
import { git, gitOk } from './exec';

export interface WorktreeInfo {
  /** Absolute path to the worktree checkout */
  path: string;
  /** Display name (directory basename) */
  name: string;
  /** Current branch, or detached HEAD short sha */
  branch: string;
  /** Whether HEAD is detached */
  detached: boolean;
  /** Absolute path to the main worktree (common root), if known */
  mainWorktreePath?: string;
}

export async function isGitWorktree(dir: string): Promise<boolean> {
  return gitOk(dir, ['rev-parse', '--is-inside-work-tree']);
}

export async function inspectWorktree(dir: string): Promise<WorktreeInfo | undefined> {
  if (!(await isGitWorktree(dir))) {
    return undefined;
  }

  const name = path.basename(dir);
  let branch = 'HEAD';
  let detached = false;

  try {
    const symbolic = (await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])).trim();
    if (symbolic) {
      branch = symbolic;
    }
  } catch {
    detached = true;
    try {
      branch = (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
    } catch {
      branch = 'unknown';
    }
  }

  let mainWorktreePath: string | undefined;
  try {
    const commonDir = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
      .trim();
    // common dir is usually <main>/.git — main worktree is its parent when .git is a directory
    if (commonDir.endsWith(`${path.sep}.git`) || commonDir.endsWith('/.git')) {
      mainWorktreePath = path.dirname(commonDir);
    } else if (commonDir.endsWith('.git')) {
      mainWorktreePath = path.dirname(commonDir);
    }
  } catch {
    // optional metadata
  }

  return {
    path: dir,
    name,
    branch,
    detached,
    mainWorktreePath,
  };
}

/**
 * Best-effort base ref for comparison:
 * 1. upstream of current branch
 * 2. configured default (if it resolves)
 * 3. main / master fallbacks
 */
export async function resolveBaseRef(
  worktreePath: string,
  defaultBaseRef: string,
): Promise<string> {
  try {
    const upstream = (
      await git(worktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    ).trim();
    if (upstream) {
      return upstream;
    }
  } catch {
    // no upstream
  }

  const candidates = [defaultBaseRef, 'main', 'master', 'origin/main', 'origin/master'];
  const seen = new Set<string>();
  for (const ref of candidates) {
    if (!ref || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    if (await gitOk(worktreePath, ['rev-parse', '--verify', `${ref}^{commit}`])) {
      return ref;
    }
  }

  return defaultBaseRef;
}
