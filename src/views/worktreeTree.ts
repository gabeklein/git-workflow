import * as vscode from 'vscode';

/**
 * Placeholder tree: shows a short getting-started message until discovery lands.
 * Feature commits will replace this with real worktree nodes and compare trees.
 */
export class WorktreeTreeProvider
  implements vscode.TreeDataProvider<PlaceholderItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    PlaceholderItem | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly output: vscode.OutputChannel) {}

  refresh(): void {
    this.output.appendLine('Refresh requested');
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PlaceholderItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PlaceholderItem): PlaceholderItem[] {
    if (element) {
      return [];
    }
    return [
      new PlaceholderItem(
        'Worktree discovery coming next',
        'Configure worktreeCompare.watchFolders (default: .claude/worktrees)',
      ),
    ];
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

class PlaceholderItem extends vscode.TreeItem {
  constructor(label: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'placeholder';
  }
}
