import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { git } from './exec';

/** One branch (local, remote, or both), recency-sorted for the panel. */
export interface BranchInfo {
  /** Short name without the remote prefix */
  name: string;
  hasLocalRef: boolean;
  hasRemote: boolean;
  /** Unix seconds of the newest tip (local or remote) */
  committerDate: number;
  relativeDate: string;
}

/**
 * All branches of the repo — refs/heads merged with refs/remotes/origin by
 * short name — newest committer date first. One git call.
 */
export async function listBranches(repoCwd: string): Promise<BranchInfo[]> {
  const out = await git(repoCwd, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%00%(committerdate:unix)%00%(committerdate:relative)',
    'refs/heads',
    'refs/remotes/origin',
  ]);
  const byName = new Map<string, BranchInfo>();
  for (const line of out.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [refname, dateRaw, relative] = line.split('\0');
    if (!refname) {
      continue;
    }
    let name: string;
    let isLocal: boolean;
    if (refname.startsWith('refs/heads/')) {
      name = refname.slice('refs/heads/'.length);
      isLocal = true;
    } else if (refname.startsWith('refs/remotes/origin/')) {
      name = refname.slice('refs/remotes/origin/'.length);
      isLocal = false;
      if (name === 'HEAD') {
        continue;
      }
    } else {
      continue;
    }
    const date = Number(dateRaw) || 0;
    const existing = byName.get(name);
    if (existing) {
      existing.hasLocalRef ||= isLocal;
      existing.hasRemote ||= !isLocal;
      if (date > existing.committerDate) {
        existing.committerDate = date;
        existing.relativeDate = relative ?? existing.relativeDate;
      }
    } else {
      byName.set(name, {
        name,
        hasLocalRef: isLocal,
        hasRemote: !isLocal,
        committerDate: date,
        relativeDate: relative ?? '',
      });
    }
  }
  return [...byName.values()].sort(
    (a, b) => b.committerDate - a.committerDate,
  );
}

export function sanitizeWorktreeDirName(name: string): string {
  return (
    name
      .replace(/[/\\:]+/g, '-')
      .replace(/[^\w.@+-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'branch'
  );
}

/**
 * Create a linked worktree for a branch. Local branches are checked out
 * directly (git refuses if already checked out elsewhere); remote-only
 * branches get a local branch created from origin/<name> (tracking is set
 * up by git's branch.autoSetupMerge default).
 */
export async function createWorktreeForBranch(
  repoCwd: string,
  branch: string,
  hasLocalRef: boolean,
  destDir: string,
): Promise<string> {
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  try {
    await fs.access(destDir);
    throw new Error(`Path already exists: ${destDir}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Path already')) {
      throw err;
    }
    // ENOENT — free to create
  }
  if (hasLocalRef) {
    await git(repoCwd, ['worktree', 'add', destDir, branch]);
  } else {
    await git(repoCwd, [
      'worktree',
      'add',
      '-b',
      branch,
      destDir,
      `origin/${branch}`,
    ]);
  }
  return destDir;
}
