import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureExcludedFromStatus } from './exclude';
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
  /** Commits this branch has that its upstream does not. */
  ahead?: number;
  /** Commits its upstream has that it does not. */
  behind?: number;
}

/**
 * All branches of the repo — refs/heads merged with refs/remotes/origin by
 * short name — newest committer date first. One git call.
 */

/**
 * Parse `%(upstream:track)` — git writes `[ahead 2, behind 1]`, `[ahead 3]`,
 * `[behind 4]`, `[gone]`, or nothing at all.
 *
 * Nothing means one of two very different things: in sync, or no upstream
 * configured. Both come back as undefined, and that is the honest answer —
 * a branch with no upstream is not "ahead" of anything, it is unpublished,
 * which the row already says by other means.
 */
function parseTrack(track?: string): { ahead?: number; behind?: number } {
  if (!track || track.includes('gone')) return {};
  const ahead = /ahead (\d+)/.exec(track)?.[1];
  const behind = /behind (\d+)/.exec(track)?.[1];
  return {
    ahead: ahead ? Number(ahead) : undefined,
    behind: behind ? Number(behind) : undefined,
  };
}

export async function listBranches(repoCwd: string): Promise<BranchInfo[]> {
  const out = await git(repoCwd, [
    'for-each-ref',
    '--sort=-committerdate',
    // upstream:track comes free in this same call — one git invocation for
    // every branch's sync state, rather than a rev-list per row.
    '--format=%(refname)%00%(committerdate:unix)%00%(committerdate:relative)%00%(upstream:track)',
    'refs/heads',
    'refs/remotes/origin',
  ]);
  const byName = new Map<string, BranchInfo>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [refname, dateRaw, relative, track] = line.split('\0');
    if (!refname) continue;
    let name: string;
    let isLocal: boolean;
    if (refname.startsWith('refs/heads/')) {
      name = refname.slice('refs/heads/'.length);
      isLocal = true;
    } else if (refname.startsWith('refs/remotes/origin/')) {
      name = refname.slice('refs/remotes/origin/'.length);
      isLocal = false;
      if (name === 'HEAD') continue;
    } else {
      continue;
    }
    const date = Number(dateRaw) || 0;
    const existing = byName.get(name);
    if (existing) {
      existing.hasLocalRef ||= isLocal;
      existing.hasRemote ||= !isLocal;
      // Only the LOCAL ref has an upstream to track; the remote row for the
      // same name carries none and must not blank what the local one said.
      if (isLocal) {
        const t = parseTrack(track);
        existing.ahead = t.ahead;
        existing.behind = t.behind;
      }
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
        ...parseTrack(track),
      });
    }
  }
  return [...byName.values()].sort(
    (a, b) => b.committerDate - a.committerDate,
  );
}

/** Default location for a new worktree: first watchFolder + sanitized name. */
export function suggestWorktreePath(workspaceRoot: string, name: string): string {
  const watch =
    vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<string[]>('watchFolders', ['.worktrees'])[0] || '.worktrees';
  return path.join(
    path.isAbsolute(watch) ? watch : path.join(workspaceRoot, watch),
    sanitizeWorktreeDirName(name),
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
    if (err instanceof Error && err.message.startsWith('Path already'))
      throw err;
    // ENOENT — free to create
  }
  // Repo-local ignore before creation, so status never flashes dirty
  await ensureExcludedFromStatus(destDir).catch(() => undefined);
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
