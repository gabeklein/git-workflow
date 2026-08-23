import * as vscode from 'vscode';
import type { TreeNode } from './nodes';
import type { WorktreeTreeProvider } from './worktreeTree';

/**
 * Changes panel: Commits / Staged / Unstaged / Full Diff for the worktree
 * selected in the Worktrees panel above. Pure presentation — state,
 * snapshots, and caches live in WorktreeTreeProvider.
 */
export class ChangesTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly worktrees: WorktreeTreeProvider) {
    this.disposables.push(
      worktrees.onDidChangeTreeData(() => this._onDidChangeTreeData.fire()),
      worktrees.onDidChangeWorktrees(() => this._onDidChangeTreeData.fire()),
    );
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): Promise<TreeNode[]> {
    return this.worktrees.getChangesChildren(element);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
