import * as vscode from 'vscode';
import { GroupItem, type TreeNode } from './nodes';
import { describeLocation } from './pathFilters';
import type { ExplorerNode, FilesTreeProvider } from './filesTree';
import type { WorktreeTreeProvider } from './worktreeTree';

/**
 * Changes panel: everything about the checkout focused in Focus above —
 * Commits / Staged / Unstaged / Full Diff, and a **Directory** section
 * that browses its working tree.
 *
 * The directory used to be its own Files panel. It is the same subject as
 * the diffs, and a whole panel to say "and here are the files" earned less
 * than the vertical space it took. It is called Directory and not Files
 * because under a panel named Changes, "Files" reads as *the changed
 * files* — which is the one thing this section is not.
 *
 * It cannot be replaced by the built-in Explorer, which only reveals paths
 * inside a workspace folder — a sibling worktree is outside every one of
 * them — and converting the window to multi-root restarts the extension
 * host (see filesTree.ts).
 *
 * Pure composition: state, snapshots and caches stay in the two providers
 * this delegates to.
 */

type ChangesNode = TreeNode | ExplorerNode;

function isExplorerNode(node: ChangesNode): node is ExplorerNode {
  return node.kind.startsWith('explorer');
}

export class ChangesTreeProvider
  implements vscode.TreeDataProvider<ChangesNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ChangesNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly worktrees: WorktreeTreeProvider,
    private readonly files: FilesTreeProvider,
  ) {
    this.disposables.push(
      worktrees.onDidChangeTreeData(() => this._onDidChangeTreeData.fire()),
      worktrees.onDidChangeWorktrees(() => this._onDidChangeTreeData.fire()),
      // The files half has watchers of its own (create/delete/rename), which
      // the diff half has no reason to care about — forward them so a new
      // file appears in the section without waiting for git activity.
      files.onDidChangeTreeData(() => this._onDidChangeTreeData.fire()),
    );
  }

  getTreeItem(element: ChangesNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ChangesNode): Promise<ChangesNode[]> {
    if (element && isExplorerNode(element))
      return this.files.getChildren(element);
    if (element?.kind === 'group' && element.group === 'directory')
      return this.files.getChildren();
    if (element) return this.worktrees.getChangesChildren(element);
    const changes = await this.worktrees.getChangesChildren();
    // No selection: the diff half already says so — a second "select a
    // worktree" under a Directory header is the same sentence twice.
    if (!this.worktrees.getSelectedPath()) return changes;
    const root = this.worktrees.getSelectedPath();
    // Warnings stay at the very top, above Directory. They are banners
    // about the focused checkout, and a banner sitting under a collapsible
    // group reads as belonging to that group — which is exactly how it
    // looked once Directory moved to the top.
    const banners = changes.filter((n) => n.kind === 'conflictWarning');
    const rest = changes.filter((n) => n.kind !== 'conflictWarning');
    return [
      ...banners,
      new GroupItem(
        'Directory',
        'directory',
        vscode.TreeItemCollapsibleState.Collapsed,
        // Where this checkout actually is. Worktrees are usually siblings
        // of the open folder, so the relationship is the useful part —
        // `../gw-demo/repo` says something an absolute path buries.
        root
          ? describeLocation(
              root,
              vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            )
          : undefined,
      ),
      ...rest,
    ];
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
