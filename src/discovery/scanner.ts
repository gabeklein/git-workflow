import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { git, gitOk } from '../git/exec';
import { listWorktreeAdmin } from '../git/worktreeAdmin';
import { inspectWorktree, type WorktreeInfo } from '../git/worktree';

export interface DiscoveredWorktree extends WorktreeInfo {
  /** Workspace folder this worktree was found under (if any) */
  workspaceFolder?: vscode.WorkspaceFolder;
  /** Relative path from workspace folder, when applicable */
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

export type RootCheckoutMode = 'always' | 'dirty' | 'never';

function getWatchFolders(): string[] {
  const config = vscode.workspace.getConfiguration('worktreeCompare');
  const folders = config.get<string[]>('watchFolders', ['.claude/worktrees']);
  return folders.length > 0 ? folders : ['.claude/worktrees'];
}

function getRootCheckoutMode(): RootCheckoutMode {
  const v = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<string>('includeRootCheckout', 'dirty');
  if (v === 'always' || v === 'never') {
    return v;
  }
  return 'dirty';
}

/** Cheap dirty probe for root-checkout visibility. */
async function probeDirty(dir: string): Promise<boolean> {
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

/** Branch has remote tip → pushed; else local-only. */
async function probePublishState(
  dir: string,
  branch: string,
  detached: boolean,
): Promise<'pushed' | 'local' | undefined> {
  if (detached || !branch || branch === 'HEAD' || branch === 'unknown') {
    return undefined;
  }
  try {
    if (await gitOk(dir, ['rev-parse', '--verify', `@{upstream}^{commit}`])) {
      return 'pushed';
    }
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

async function listDirectChildDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Scan workspace roots + configured watch folders for git worktrees.
 * Inspects children with limited concurrency (avoids serial git storms).
 */
export async function discoverWorktrees(
  output?: { appendLine(value: string): void },
): Promise<DiscoveredWorktree[]> {
  const t0 = Date.now();
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const watchFolders = getWatchFolders();
  const rootMode = getRootCheckoutMode();
  const found: DiscoveredWorktree[] = [];
  const seen = new Set<string>();

  if (workspaceFolders.length === 0) {
    output?.appendLine('No workspace folder open — nothing to scan');
    return found;
  }

  // 1) Workspace root checkouts (main repo) — optional via setting
  if (rootMode !== 'never') {
    for (const folder of workspaceFolders) {
      const rootPath = path.normalize(folder.uri.fsPath);
      if (seen.has(rootPath)) {
        continue;
      }
      try {
        const info = await inspectWorktree(rootPath);
        if (!info) {
          continue;
        }
        const dirty = await probeDirty(rootPath);
        if (rootMode === 'dirty' && !dirty) {
          output?.appendLine(
            `Root checkout clean, omitted (includeRootCheckout=dirty): ${rootPath}`,
          );
          continue;
        }
        seen.add(rootPath);
        const publishState = await probePublishState(
          rootPath,
          info.branch,
          info.detached,
        );
        found.push({
          ...info,
          // Prefer stable label for root vs folder basename alone
          name: info.name,
          workspaceFolder: folder,
          relativePath: '.',
          isRootCheckout: true,
          isDirty: dirty,
          publishState,
        });
        output?.appendLine(
          `Root checkout: ${info.branch} @ ${rootPath}${dirty ? ' (dirty)' : ''}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output?.appendLine(`Root checkout skip ${rootPath}: ${message}`);
      }
    }
  }

  // 2) Linked / agent worktrees under watch folders
  type Job = { absPath: string; workspaceFolder: vscode.WorkspaceFolder };
  const jobs: Job[] = [];

  for (const folder of workspaceFolders) {
    for (const watch of watchFolders) {
      const watchAbs = path.isAbsolute(watch)
        ? watch
        : path.join(folder.uri.fsPath, watch);
      output?.appendLine(`Scanning ${watchAbs}`);
      const children = await listDirectChildDirs(watchAbs);
      for (const child of children) {
        jobs.push({ absPath: child, workspaceFolder: folder });
      }
    }
  }

  output?.appendLine(`Discovery: ${jobs.length} linked-worktree candidate(s)`);

  const concurrency = 6;
  let next = 0;

  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i]!;
      const normalized = path.normalize(job.absPath);
      if (seen.has(normalized)) {
        continue;
      }
      try {
        const info = await inspectWorktree(normalized);
        if (!info) {
          continue;
        }
        seen.add(normalized);
        const relativePath = path.relative(
          job.workspaceFolder.uri.fsPath,
          normalized,
        );
        const publishState = await probePublishState(
          normalized,
          info.branch,
          info.detached,
        );
        found.push({
          ...info,
          workspaceFolder: job.workspaceFolder,
          relativePath:
            relativePath && !relativePath.startsWith('..')
              ? relativePath
              : undefined,
          isRootCheckout: false,
          publishState,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output?.appendLine(`Discovery skip ${normalized}: ${message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(jobs.length, 1)) }, () =>
      worker(),
    ),
  );

  // Enrich with lock / main flags from a single porcelain list
  if (found.length > 0) {
    try {
      const admin = await listWorktreeAdmin(found[0]!.path);
      for (const wt of found) {
        const key = path.normalize(wt.path);
        let state = admin.get(key);
        if (!state) {
          for (const s of admin.values()) {
            if (path.normalize(s.path) === key) {
              state = s;
              break;
            }
          }
        }
        if (state) {
          wt.isMainWorktree = state.isMain;
          wt.locked = state.locked;
          wt.lockReason = state.lockReason;
        } else if (wt.isRootCheckout) {
          wt.isMainWorktree = true;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output?.appendLine(`worktree list --porcelain failed: ${message}`);
      for (const wt of found) {
        if (wt.isRootCheckout) {
          wt.isMainWorktree = true;
        }
      }
    }
  }

  // Root first, then linked worktrees by branch
  found.sort((a, b) => {
    if (a.isRootCheckout !== b.isRootCheckout) {
      return a.isRootCheckout ? -1 : 1;
    }
    const byBranch = a.branch.localeCompare(b.branch);
    return byBranch !== 0 ? byBranch : a.name.localeCompare(b.name);
  });
  output?.appendLine(
    `Discovered ${found.length} worktree(s) in ${Date.now() - t0}ms (rootMode=${rootMode})`,
  );
  return found;
}

/** Absolute directories scanned for linked-worktree children. */
export function resolveWatchRoots(): string[] {
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

/** Sorted child-dir lists of each watch root — cheap, no git. */
export async function watchRootsFingerprint(): Promise<string> {
  const parts: string[] = [];
  for (const root of resolveWatchRoots()) {
    const children = await listDirectChildDirs(root);
    parts.push(`${path.normalize(root)}\0${children.sort().join('\0')}`);
  }
  return parts.join('\n');
}

/** True when `fsPath` is a direct child of a configured watch root. */
export function isDirectChildOfWatchRoot(fsPath: string): boolean {
  const resolved = path.resolve(fsPath);
  const parent = path.dirname(resolved);
  for (const root of resolveWatchRoots()) {
    if (parent === path.resolve(root)) {
      return true;
    }
  }
  return false;
}
