import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { git, gitOk } from './exec';
import { isWorktreeDirty } from './plumbing';
import { integrationBranch } from './integration/config';
import { listWorktreeAdmin, type WorktreeAdminState } from './worktreeAdmin';

/** What `git worktree list` knows about a checkout, before we look closer. */
interface WorktreeInfo {
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

/** …and what the panels need on top of it. */
export interface DiscoveredWorktree extends WorktreeInfo {
  /** Workspace folder this worktree belongs to (repo opened in it) */
  workspaceFolder?: vscode.WorkspaceFolder;
  /** Relative path from workspace folder, when the worktree is inside it */
  relativePath?: string;
  /** True when this is the workspace root checkout (not under watchFolders). */
  isRootCheckout?: boolean;
  /** Working tree has uncommitted changes (best-effort; used for root visibility). */
  isDirty?: boolean;
  /** Primary repo checkout — cannot be removed with git worktree remove. */
  isMainWorktree?: boolean;
  /** git worktree lock is set */
  locked?: boolean;
  lockReason?: string;
  /**
   * Whether the branch has a remote-tracking tip (origin/<branch> or @{upstream}).
   * Used for no-PR row labels: pushed vs local.
   */
  publishState?: 'pushed' | 'local';
}

type RootCheckoutMode = 'always' | 'dirty' | 'never';

function getWatchFolders(): string[] {
  const config = vscode.workspace.getConfiguration('worktreeCompare');
  const folders = config.get<string[]>('watchFolders', ['.worktrees']);
  return folders.length > 0 ? folders : ['.worktrees'];
}

function getRootCheckoutMode(): RootCheckoutMode {
  const v = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<string>('includeRootCheckout', 'dirty');
  if (v === 'always' || v === 'never') return v;
  return 'dirty';
}

/** Branch has remote tip → pushed; else local-only. */
async function probePublishState(
  dir: string,
  branch: string,
  detached: boolean,
): Promise<'pushed' | 'local' | undefined> {
  if (detached || !branch || branch === 'HEAD' || branch === 'unknown')
    return undefined;
  try {
    if (await gitOk(dir, ['rev-parse', '--verify', `@{upstream}^{commit}`]))
      return 'pushed';
  } catch {
    // no upstream
  }
  for (const remote of ['origin', 'upstream']) {
    if (
      await gitOk(dir, [
        'rev-parse',
        '--verify',
        `${remote}/${branch}^{commit}`,
      ])
    ) {
      return 'pushed';
    }
  }
  return 'local';
}

/**
 * All worktrees registered with the repo(s) opened in the workspace,
 * from `git worktree list --porcelain` — regardless of where they live
 * on disk. Repos are deduped when multiple workspace folders share one.
 */
async function listRegisteredWorktrees(
  output?: { appendLine(value: string): void },
): Promise<
  Array<{ admin: WorktreeAdminState; workspaceFolder: vscode.WorkspaceFolder }>
> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const seenRepos = new Set<string>();
  const entries: Array<{
    admin: WorktreeAdminState;
    workspaceFolder: vscode.WorkspaceFolder;
  }> = [];

  for (const folder of workspaceFolders) {
    const rootPath = path.normalize(folder.uri.fsPath);
    let admin: Map<string, WorktreeAdminState>;
    try {
      admin = await listWorktreeAdmin(rootPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output?.appendLine(`Not a git repo, skipped: ${rootPath} (${message})`);
      continue;
    }
    // Dedup repos: the main worktree path identifies the repo
    const mainPath =
      [...admin.values()].find((s) => s.isMain)?.path ?? rootPath;
    if (seenRepos.has(mainPath)) continue;
    seenRepos.add(mainPath);
    for (const state of admin.values()) {
      entries.push({ admin: state, workspaceFolder: folder });
    }
  }
  return entries;
}

/**
 * Discover worktrees via `git worktree list` from each workspace folder's
 * repo. Every registered worktree is listed no matter where it lives on
 * disk; the workspace-root / main checkout is gated by includeRootCheckout.
 */
export async function discoverWorktrees(
  output?: { appendLine(value: string): void },
): Promise<DiscoveredWorktree[]> {
  const t0 = Date.now();
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const rootMode = getRootCheckoutMode();
  const found: DiscoveredWorktree[] = [];

  if (workspaceFolders.length === 0) {
    output?.appendLine('No workspace folder open — nothing to list');
    return found;
  }

  const workspaceRoots = new Set(
    workspaceFolders.map((f) => path.normalize(f.uri.fsPath)),
  );

  const entries = await listRegisteredWorktrees(output);
  output?.appendLine(
    `Discovery: ${entries.length} registered worktree(s) from git worktree list`,
  );

  const concurrency = 6;
  let next = 0;

  async function worker(): Promise<void> {
    while (next < entries.length) {
      const i = next++;
      const { admin, workspaceFolder } = entries[i]!;
      const normalized = path.normalize(admin.path);
      if (admin.bare) continue;
      if (admin.prunable) {
        output?.appendLine(`Skipping prunable worktree: ${normalized}`);
        continue;
      }
      try {
        await fs.access(normalized);
      } catch {
        output?.appendLine(`Skipping missing worktree dir: ${normalized}`);
        continue;
      }

      const isRootCheckout = workspaceRoots.has(normalized);
      const branch = admin.detached
        ? (admin.head ?? 'unknown').slice(0, 7) || 'unknown'
        : (admin.branch ?? 'unknown');

      try {
        let dirty: boolean | undefined;
        // Root / main checkouts are gated by includeRootCheckout — except on
        // the integration branch (integration mode must stay visible)
        const isIntegration =
          !admin.detached && branch === integrationBranch();
        if ((isRootCheckout || admin.isMain) && !isIntegration) {
          if (rootMode === 'never') continue;
          dirty = await isWorktreeDirty(normalized);
          if (rootMode === 'dirty' && !dirty) {
            output?.appendLine(
              `Root checkout clean, omitted (includeRootCheckout=dirty): ${normalized}`,
            );
            continue;
          }
        }
        const publishState = await probePublishState(
          normalized,
          branch,
          admin.detached,
        );
        const relativePath = path.relative(
          workspaceFolder.uri.fsPath,
          normalized,
        );
        found.push({
          path: normalized,
          name: path.basename(normalized),
          branch,
          detached: admin.detached,
          workspaceFolder,
          relativePath:
            relativePath === ''
              ? '.'
              : !relativePath.startsWith('..') &&
                  !path.isAbsolute(relativePath)
                ? relativePath
                : undefined,
          isRootCheckout,
          isDirty: dirty,
          isMainWorktree: admin.isMain,
          locked: admin.locked,
          lockReason: admin.lockReason,
          publishState,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output?.appendLine(`Discovery skip ${normalized}: ${message}`);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(entries.length, 1)) },
      () => worker(),
    ),
  );

  // Root first, then linked worktrees by branch
  found.sort((a, b) => {
    if (a.isRootCheckout !== b.isRootCheckout) return a.isRootCheckout ? -1 : 1;
    const byBranch = a.branch.localeCompare(b.branch);
    return byBranch !== 0 ? byBranch : a.name.localeCompare(b.name);
  });
  output?.appendLine(
    `Discovered ${found.length} worktree(s) in ${Date.now() - t0}ms (rootMode=${rootMode})`,
  );
  return found;
}

/** Absolute watch-folder dirs — still used as the default creation location
 *  for new (PR) worktrees and as an event fast-path hint. */
function resolveWatchRoots(): string[] {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const watchFolders = getWatchFolders();
  const roots: string[] = [];

  for (const folder of workspaceFolders) {
    for (const watch of watchFolders) {
      const watchAbs = path.isAbsolute(watch)
        ? watch
        : path.join(folder.uri.fsPath, watch);
      roots.push(watchAbs);
    }
  }
  return roots;
}

/**
 * Membership fingerprint: paths + branches from `git worktree list`.
 * One git call per repo — cheap enough for the poll interval, and it sees
 * worktrees added or removed anywhere on disk.
 */
export async function worktreeListFingerprint(): Promise<string> {
  const entries = await listRegisteredWorktrees();
  return entries
    .map(
      ({ admin }) =>
        `${path.normalize(admin.path)}\0${admin.branch ?? admin.head ?? ''}`,
    )
    .sort()
    .join('\n');
}

/** Unique .git common dirs of the repos opened in the workspace. */
export async function resolveRepoCommonDirs(): Promise<string[]> {
  const dirs: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    try {
      const out = (await git(root, ['rev-parse', '--git-common-dir'])).trim();
      const abs = path.normalize(path.resolve(root, out));
      if (!dirs.includes(abs)) dirs.push(abs);
    } catch {
      // not a git repo
    }
  }
  return dirs;
}

/** True when `fsPath` is a direct child of a configured watch root. */
export function isDirectChildOfWatchRoot(fsPath: string): boolean {
  const resolved = path.resolve(fsPath);
  const parent = path.dirname(resolved);
  for (const root of resolveWatchRoots()) {
    if (parent === path.resolve(root)) return true;
  }
  return false;
}
