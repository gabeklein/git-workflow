import * as path from 'node:path';
import { git, GitError } from './exec';

/** Admin metadata from `git worktree list --porcelain`. */
export interface WorktreeAdminState {
  path: string;
  /** First / primary checkout — cannot be removed. */
  isMain: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  bare: boolean;
  detached: boolean;
  branch?: string;
  head?: string;
}

/**
 * Parse `git worktree list --porcelain` from any checkout of the repo.
 * Paths are normalized absolute paths.
 */
export async function listWorktreeAdmin(
  anyWorktreePath: string,
): Promise<Map<string, WorktreeAdminState>> {
  const out = await git(anyWorktreePath, ['worktree', 'list', '--porcelain']);
  const map = new Map<string, WorktreeAdminState>();
  let current: Partial<WorktreeAdminState> | undefined;
  let isFirst = true;

  const flush = () => {
    if (!current?.path) {
      current = undefined;
      return;
    }
    const abs = path.normalize(current.path);
    map.set(abs, {
      path: abs,
      isMain: Boolean(current.isMain),
      locked: Boolean(current.locked),
      lockReason: current.lockReason,
      prunable: Boolean(current.prunable),
      bare: Boolean(current.bare),
      detached: Boolean(current.detached),
      branch: current.branch,
      head: current.head,
    });
    current = undefined;
  };

  for (const line of out.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current = {
        path: line.slice('worktree '.length).trim(),
        isMain: isFirst,
        locked: false,
        prunable: false,
        bare: false,
        detached: false,
      };
      isFirst = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith('branch ')) {
      const ref = line.slice(7).trim();
      current.branch = ref.replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line.startsWith('locked')) {
      current.locked = true;
      // `locked` or `locked <reason>`
      const reason = line.slice('locked'.length).trim();
      if (reason) current.lockReason = reason;
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  flush();
  return map;
}

type RemoveWorktreeResult =
  | { ok: true }
  | { ok: false; code: 'main' | 'locked' | 'dirty' | 'error'; message: string };

/**
 * Remove a linked worktree via `git worktree remove`.
 * Does **not** delete the branch.
 *
 * - clean → `worktree remove <path>`
 * - dirty → needs `force: true` (`-f`)
 * - locked → needs `forceLocked: true` (`-f -f`) or unlock first
 */
export async function removeWorktree(
  worktreePath: string,
  options: { force?: boolean; forceLocked?: boolean } = {},
): Promise<RemoveWorktreeResult> {
  const normalized = path.normalize(worktreePath);
  let admin: WorktreeAdminState | undefined;
  try {
    const all = await listWorktreeAdmin(normalized);
    admin = all.get(normalized);
    // Path key mismatch (symlink / trailing slash) — scan values
    if (!admin) {
      for (const s of all.values()) {
        if (path.normalize(s.path) === normalized) {
          admin = s;
          break;
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'error', message };
  }

  if (admin?.isMain) {
    return {
      ok: false,
      code: 'main',
      message: 'The main worktree cannot be removed.',
    };
  }

  // Prefer running from the main worktree (first entry) when known
  let cwd = normalized;
  try {
    const all = await listWorktreeAdmin(normalized);
    for (const s of all.values()) {
      if (s.isMain) {
        cwd = s.path;
        break;
      }
    }
  } catch {
    // fall back to the worktree itself
  }

  const args = ['worktree', 'remove'];
  if (options.forceLocked) {
    args.push('--force', '--force');
  } else if (options.force) {
    args.push('--force');
  }
  args.push(normalized);

  try {
    await git(cwd, args);
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof GitError
        ? err.stderr.trim() || err.message
        : err instanceof Error
          ? err.message
          : String(err);
    const lower = message.toLowerCase();
    if (lower.includes('locked')) return { ok: false, code: 'locked', message };
    if (
      lower.includes('contains modified') ||
      lower.includes('untracked') ||
      lower.includes('not empty') ||
      lower.includes('use --force')
    ) {
      return { ok: false, code: 'dirty', message };
    }
    return { ok: false, code: 'error', message };
  }
}

export async function unlockWorktree(worktreePath: string): Promise<void> {
  const normalized = path.normalize(worktreePath);
  let cwd = normalized;
  try {
    const all = await listWorktreeAdmin(normalized);
    for (const s of all.values()) {
      if (s.isMain) {
        cwd = s.path;
        break;
      }
    }
  } catch {
    // ignore
  }
  await git(cwd, ['worktree', 'unlock', normalized]);
}
