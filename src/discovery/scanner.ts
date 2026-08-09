import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { git } from '../git/exec';
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
    .get<string>('includeRootCheckout', 'always');
  if (v === 'dirty' || v === 'never') {
    return v;
  }
  return 'always';
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
        found.push({
          ...info,
          // Prefer stable label for root vs folder basename alone
          name: info.name,
          workspaceFolder: folder,
          relativePath: '.',
          isRootCheckout: true,
          isDirty: dirty,
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
        found.push({
          ...info,
          workspaceFolder: job.workspaceFolder,
          relativePath:
            relativePath && !relativePath.startsWith('..')
              ? relativePath
              : undefined,
          isRootCheckout: false,
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

/** Absolute directories that should be watched for create/delete of worktrees. */
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
