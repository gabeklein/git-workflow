import * as vscode from 'vscode';
import type { DiscoveredWorktree } from '../git/discovery';

interface WorktreeQuickPickItem extends vscode.QuickPickItem {
  worktree: DiscoveredWorktree;
}

/**
 * Pick one discovered worktree to focus in the sidebar.
 */
export async function pickWorktree(
  worktrees: DiscoveredWorktree[],
  currentPath?: string,
): Promise<DiscoveredWorktree | undefined> {
  if (worktrees.length === 0) {
    void vscode.window.showInformationMessage('Git Workflow: no worktrees discovered');
    return undefined;
  }

  const items: WorktreeQuickPickItem[] = worktrees.map((wt) => {
    const branch = wt.branch + (wt.detached ? ' (detached)' : '');
    return {
      label: branch,
      description: wt.name,
      detail: wt.relativePath ?? wt.path,
      worktree: wt,
      picked: wt.path === currentPath,
    };
  });

  // Put current selection first for faster access
  items.sort((a, b) => {
    if (a.worktree.path === currentPath) return -1;
    if (b.worktree.path === currentPath) return 1;
    return a.label.localeCompare(b.label);
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select Worktree',
    placeHolder: 'Branch or worktree folder',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return picked?.worktree;
}
