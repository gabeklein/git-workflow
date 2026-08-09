import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { inspectWorktree, type WorktreeInfo } from '../git/worktree';

export interface DiscoveredWorktree extends WorktreeInfo {
  /** Workspace folder this worktree was found under (if any) */
  workspaceFolder?: vscode.WorkspaceFolder;
  /** Relative path from workspace folder, when applicable */
  relativePath?: string;
}

function getWatchFolders(): string[] {
  const config = vscode.workspace.getConfiguration('worktreeCompare');
  const folders = config.get<string[]>('watchFolders', ['.claude/worktrees']);
  return folders.length > 0 ? folders : ['.claude/worktrees'];
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
 * Scan configured watch folders under each workspace folder for git worktrees.
 * Inspects children with limited concurrency (avoids serial git storms).
 */
export async function discoverWorktrees(
  output?: { appendLine(value: string): void },
): Promise<DiscoveredWorktree[]> {
  const t0 = Date.now();
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const watchFolders = getWatchFolders();
  const found: DiscoveredWorktree[] = [];
  const seen = new Set<string>();

  if (workspaceFolders.length === 0) {
    output?.appendLine('No workspace folder open — nothing to scan');
    return found;
  }

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

  output?.appendLine(`Discovery: ${jobs.length} candidate dir(s)`);

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

  found.sort((a, b) => {
    const byBranch = a.branch.localeCompare(b.branch);
    return byBranch !== 0 ? byBranch : a.name.localeCompare(b.name);
  });
  output?.appendLine(
    `Discovered ${found.length} worktree(s) in ${Date.now() - t0}ms`,
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
