import * as vscode from 'vscode';
import { integrationBranch } from '../git/integration';
import { BranchItem, GroupItem, MessageItem, type TreeNode } from './nodes';
import { planFocusRows } from './focusPlan';
import type { BranchesTreeProvider } from './branchesTree';
import type { WorktreeTreeProvider } from './worktreeTree';

/**
 * Focus panel: one list of the repo's branches, ordered by how live they
 * are.
 *
 * A worktree is an ACTIVITY STATUS of a branch rather than a separate kind
 * of object, so checkouts sort to the top as themselves — root first, then
 * most recently committed — and everything else waits below as a branch
 * that could become one. A branch is never in two places at once.
 *
 * State stays where it already lives: WorktreeTreeProvider owns discovery,
 * selection and integration; BranchesTreeProvider owns the branch list and
 * PR association. This provider only decides what the rows are.
 */
export class FocusTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly worktrees: WorktreeTreeProvider,
    private readonly branches: BranchesTreeProvider,
  ) {
    this.disposables.push(
      worktrees.onDidChangeTreeData(() => this._onDidChangeTreeData.fire()),
      worktrees.onDidChangeWorktrees(() => this._onDidChangeTreeData.fire()),
      branches.onDidChangeTreeData(() => this._onDidChangeTreeData.fire()),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    const cwd = this.branches.getRepoCwd();
    if (element?.kind === 'branch' && element.pr) {
      return this.branches.getPrFileRows(element.repoCwd, element.pr);
    }
    if (element?.kind === 'group') {
      if (!cwd) {
        return [];
      }
      const plan = this.plan();
      return element.group === 'branches'
        ? this.branchRows(cwd, plan.branches, plan.hiddenBranches)
        : this.branchRows(cwd, plan.remote, plan.hiddenRemote);
    }
    if (element) {
      return [];
    }
    if (!cwd) {
      return [new MessageItem('No repository folder open')];
    }
    const error = this.branches.getError();
    if (error) {
      return [new MessageItem('Could not list branches', error, 'error')];
    }
    return this.rootRows();
  }

  private plan() {
    return planFocusRows({
      worktrees: this.worktrees.getWorktrees(),
      branches: this.branches.getBranches(),
      prHeads: this.branches.getPrHeads(),
      integrationBranch: integrationBranch(),
      integrationPath: this.worktrees.getIntegration()?.path,
    });
  }

  private rootRows(): TreeNode[] {
    const plan = this.plan();
    const rows: TreeNode[] = plan.checkouts.map((wt) =>
      this.worktrees.buildCheckoutRow(wt),
    );
    if (rows.length === 0 && this.branches.isLoading()) {
      rows.push(new MessageItem('Loading…', undefined, 'loading~spin'));
    }
    // Groups stay collapsed: the live checkouts above are what the panel is
    // for, and expanding Remote is what pays for PR association.
    rows.push(
      new GroupItem(
        'Branches',
        'branches',
        vscode.TreeItemCollapsibleState.Collapsed,
        plan.branches.length > 0 ? String(plan.branches.length) : 'none',
      ),
      new GroupItem(
        'Remote',
        'remote',
        vscode.TreeItemCollapsibleState.Collapsed,
        plan.remote.length > 0 ? String(plan.remote.length) : 'none',
      ),
    );
    return rows;
  }

  private branchRows(
    cwd: string,
    list: ReturnType<BranchesTreeProvider['getBranches']>,
    hidden: number,
  ): TreeNode[] {
    if (list.length === 0) {
      return [new MessageItem('None')];
    }
    const rows: TreeNode[] = list.map(
      (b) =>
        new BranchItem(
          cwd,
          b.name,
          b.hasLocalRef,
          b.hasRemote,
          b.relativeDate,
          undefined, // a branch with a checkout is never in this group
          this.branches.getPullRequestFor(b.name),
        ),
    );
    if (hidden > 0) {
      rows.push(
        new MessageItem(`${hidden} older branch(es) not shown`, 'git branch -a'),
      );
    }
    return rows;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
