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
 */
export async function discoverWorktrees(
  output?: vscode.OutputChannel,
): Promise<DiscoveredWorktree[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const watchFolders = getWatchFolders();
  const found: DiscoveredWorktree[] = [];
  const seen = new Set<string>();

  const consider = async (
    absPath: string,
    workspaceFolder?: vscode.WorkspaceFolder,
  ): Promise<void> => {
    const normalized = path.normalize(absPath);
    if (seen.has(normalized)) {
      return;
    }
    const info = await inspectWorktree(normalized);
    if (!info) {
      return;
    }
    seen.add(normalized);
    const relativePath = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, normalized)
      : undefined;
    found.push({
      ...info,
      workspaceFolder,
      relativePath: relativePath && !relativePath.startsWith('..') ? relativePath : undefined,
    });
  };

  if (workspaceFolders.length === 0) {
    output?.appendLine('No workspace folder open — nothing to scan');
    return found;
  }

  for (const folder of workspaceFolders) {
    for (const watch of watchFolders) {
      const watchAbs = path.isAbsolute(watch)
        ? watch
        : path.join(folder.uri.fsPath, watch);
      output?.appendLine(`Scanning ${watchAbs}`);
      const children = await listDirectChildDirs(watchAbs);
      for (const child of children) {
        await consider(child, folder);
      }
    }
  }

  // Primary label is branch name — sort that way
  found.sort((a, b) => {
    const byBranch = a.branch.localeCompare(b.branch);
    return byBranch !== 0 ? byBranch : a.name.localeCompare(b.name);
  });
  output?.appendLine(`Discovered ${found.length} worktree(s)`);
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
