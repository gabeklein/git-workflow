import * as vscode from 'vscode';
import { IntegrationLaneItem, MessageItem, type TreeNode } from './nodes';
import type { WorktreeTreeProvider } from './worktreeTree';

/**
 * Dedicated Integration panel (below the Worktree view). State lives in
 * WorktreeTreeProvider (discovery, watchers, and rebuild share its plumbing);
 * this provider only renders it: candidate lanes as root rows with apply
 * checkboxes. On/off, base, and error status go on the view description
 * (set in extension.ts); when off, an empty tree shows the viewsWelcome
 * content with the Enable button.
 */
export class IntegrationTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly worktrees: WorktreeTreeProvider) {
    // Integration state changes always fire one of these
    this.disposables.push(
      worktrees.onDidChangeTreeData(() => this._onDidChangeTreeData.fire()),
      worktrees.onDidChangeWorktrees(() => this._onDidChangeTreeData.fire()),
    );
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element) {
      return [];
    }
    const integration = this.worktrees.getIntegration();
    if (!integration) {
      return []; // empty → viewsWelcome renders the Enable button
    }
    if (integration.candidates.length === 0) {
      return [
        new MessageItem(
          'No lanes yet',
          'Worktrees based on the integration base appear here automatically',
        ),
      ];
    }
    const branchToPath = new Map(
      this.worktrees
        .getWorktrees()
        .filter((w) => !w.detached)
        .map((w) => [w.branch, w.path] as const),
    );
    return integration.candidates.map(
      (branch) =>
        new IntegrationLaneItem(branch, integration.lanes.includes(branch), {
          conflicted:
            (integration.error?.code === 'conflict' &&
              integration.error.lane === branch) ||
            integration.conflicts.includes(branch),
          worktreePath: branchToPath.get(branch),
          wip: integration.wip.includes(branch),
          landed: integration.landed.includes(branch),
          resolving: integration.resolving.includes(branch),
          auto: !integration.explicit.includes(branch),
          autoResolved: integration.autoResolved.find((r) => r.lane === branch),
        }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
