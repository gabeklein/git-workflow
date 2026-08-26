import * as vscode from 'vscode';
import { integrationBranch } from '../git/integration';
import {
  BranchItem,
  MessageItem,
  SectionSeparatorItem,
  type TreeNode,
} from './nodes';
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
const SECTION_KEY = {
  branches: 'worktreeCompare.focus.branchesVisible',
  remote: 'worktreeCompare.focus.remoteVisible',
} as const;

export class FocusTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  /** Which sections are unfolded; remembered per workspace. */
  private visible: { branches: boolean; remote: boolean };

  constructor(
    private readonly worktrees: WorktreeTreeProvider,
    private readonly branches: BranchesTreeProvider,
    private readonly memento?: {
      get(key: string): boolean | undefined;
      update(key: string, value: boolean): Thenable<void>;
    },
  ) {
    // Branches open, Remote closed: expanding Remote is what pays for PR
    // association, so it stays opt-in.
    this.visible = {
      branches: memento?.get(SECTION_KEY.branches) ?? true,
      remote: memento?.get(SECTION_KEY.remote) ?? false,
    };
    this.disposables.push(
      worktrees.onDidChangeTreeData(() => this._onDidChangeTreeData.fire()),
      worktrees.onDidChangeWorktrees(() => this._onDidChangeTreeData.fire()),
      branches.onDidChangeTreeData(() => this._onDidChangeTreeData.fire()),
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /** Fold a section away, or bring it back. */
  toggleSection(section: 'branches' | 'remote'): void {
    this.visible[section] = !this.visible[section];
    void this.memento?.update(SECTION_KEY[section], this.visible[section]);
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    const cwd = this.branches.getRepoCwd();
    // PR rows still nest — their files ARE children of the PR.
    if (element?.kind === 'branch' && element.pr) {
      return this.branches.getPrFileRows(element.repoCwd, element.pr);
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
    const cwd = this.branches.getRepoCwd();
    const plan = this.plan();
    const rows: TreeNode[] = plan.checkouts.map((wt) =>
      this.worktrees.buildCheckoutRow(wt),
    );
    if (rows.length === 0 && this.branches.isLoading()) {
      rows.push(new MessageItem('Loading…', undefined, 'loading~spin'));
    }
    // Flat, with separators rather than groups: a branch with a checkout
    // and a branch without one are peers, and nesting would indent the
    // second kind as though it belonged to the first.
    rows.push(
      new SectionSeparatorItem(
        'branches',
        'Branches',
        plan.branches.length,
        this.visible.branches,
      ),
    );
    if (this.visible.branches && cwd) {
      rows.push(...this.branchRows(cwd, plan.branches, plan.hiddenBranches));
    }
    rows.push(
      new SectionSeparatorItem(
        'remote',
        'Remote',
        plan.remote.length,
        this.visible.remote,
      ),
    );
    if (this.visible.remote && cwd) {
      rows.push(...this.branchRows(cwd, plan.remote, plan.hiddenRemote));
    }
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
