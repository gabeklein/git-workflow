import * as vscode from 'vscode';
import type { DiscoveredWorktree } from '../discovery/scanner';
import type { WorktreeTreeProvider } from './worktreeTree';

/**
 * Top sidebar TreeView: flat list of discovered worktrees.
 * Click selects focus for the Details tree below.
 */
export class WorktreeListProvider
  implements vscode.TreeDataProvider<WorktreeListItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    WorktreeListItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly main: WorktreeTreeProvider) {
    this.disposables.push(
      main.onDidChangeWorktrees(() => {
        this._onDidChangeTreeData.fire();
      }),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WorktreeListItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorktreeListItem): WorktreeListItem[] {
    if (element) {
      return [];
    }
    const selected = this.main.getSelectedPath();
    const list = this.main.getWorktrees();
    if (list.length === 0) {
      return [];
    }
    return list.map((wt) => new WorktreeListItem(wt, wt.path === selected));
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}

export class WorktreeListItem extends vscode.TreeItem {
  readonly worktreePath: string;

  constructor(worktree: DiscoveredWorktree, selected: boolean) {
    const branchLabel =
      worktree.branch + (worktree.detached ? ' (detached)' : '');
    super(branchLabel, vscode.TreeItemCollapsibleState.None);
    this.worktreePath = worktree.path;
    this.description = worktree.name;
    this.contextValue = selected ? 'worktreeListItemActive' : 'worktreeListItem';
    this.iconPath = new vscode.ThemeIcon(
      selected ? 'circle-filled' : 'circle-outline',
    );
    this.tooltip = [
      branchLabel,
      `Folder: ${worktree.name}`,
      worktree.path,
      selected ? 'Selected' : 'Click to select',
    ].join('\n');
    this.command = {
      command: 'worktreeCompare.focusWorktree',
      title: 'Focus Worktree',
      arguments: [this.worktreePath],
    };
  }
}
