import * as vscode from 'vscode';
import { previewBaseRef, previewBranch } from '../git/preview';
import { GroupItem, MessageItem, type TreeNode } from './nodes';
import { BranchItem } from './nodes/branches';
import { BaseDriftItem, PreviewLaneItem, PreviewItem } from './nodes/lanes';
import { planLaneRows, type LandedLane } from './lanesPlan';
import type { BranchesTreeProvider } from './branchesTree';
import type { WorktreeTreeProvider } from './worktreeTree';

/**
 * Lanes panel: every line of work in the repo, grouped by how live it is.
 *
 * A worktree is an ACTIVITY STATUS of a branch rather than a separate kind
 * of object, so the groups form a ladder — Working has a checkout, Local
 * has a ref, Remote has neither, Landed is done — and a branch appears in
 * exactly one of them. Sync state against the remote shows as badges on a
 * Local row rather than listing the branch twice.
 *
 * Landed renders LAST but is decided FIRST, so a landed branch that still
 * has a checkout reaches the group whose whole purpose is cleaning it up.
 *
 * State stays where it already lives: WorktreeTreeProvider owns discovery,
 * selection and preview; BranchesTreeProvider owns the branch list, PR
 * association and the landed set. This provider only decides what the rows
 * are.
 */
export class LanesTreeProvider
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
    // PR rows still nest — their files ARE children of the PR.
    if (element?.kind === 'branch' && element.pr)
      return this.branches.getPrFileRows(element.repoCwd, element.pr);
    if (element?.kind === 'group') {
      if (!cwd) return [];
      const plan = this.plan();
      switch (element.group) {
        case 'working':
          return plan.working.length > 0
            ? plan.working.map((wt) => this.worktrees.buildCheckoutRow(wt))
            : [new MessageItem('No checkouts')];
        case 'landed':
          return this.landedRows(cwd, plan.landed);
        case 'local':
          return this.branchRows(cwd, plan.local, plan.hiddenLocal);
        default:
          return this.branchRows(cwd, plan.remote, plan.hiddenRemote);
      }
    }
    // A preview's children are its lanes — drift first, since it is the
    // base's own unlanded work and merges before everything else.
    if (element?.kind === 'preview') return this.laneRows();
    if (element) return [];
    if (!cwd) return [new MessageItem('No repository folder open')];
    const error = this.branches.getError();
    if (error)
      return [new MessageItem('Could not list branches', error, 'error')];
    return this.rootRows();
  }

  private plan() {
    return planLaneRows({
      worktrees: this.worktrees.getWorktrees(),
      branches: this.branches.getBranches(),
      prHeads: this.branches.getPrHeads(),
      previewBranch: previewBranch(),
      previewPath: this.worktrees.getPreview()?.path,
      landed: this.branches.getLanded(),
    });
  }

  private rootRows(): TreeNode[] {
    const plan = this.plan();
    if (plan.working.length === 0 && this.branches.isLoading())
      return [new MessageItem('Loading…', undefined, 'loading~spin')];
    const group = (
      label: string,
      key: 'working' | 'local' | 'remote' | 'landed',
      count: number,
      open: boolean,
    ) =>
      new GroupItem(
        label,
        key,
        open
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
        count > 0 ? String(count) : 'none',
      );
    const rows: TreeNode[] = [
      // The preview leads, and it is a ROW rather than a group: there is
      // exactly one, so a heading over it would be a list that can never
      // hold a second entry and a count that only ever reads 1. Present
      // even when off — a hidden feature is an undiscovered one — where it
      // is the row that offers to turn it on.
      this.previewRow(),
      group('Working', 'working', plan.working.length, true),
      // Closed by default: Local is where branches wait, and the list grows
      // without bound in a busy repo. Working is what you are doing.
      group('Local', 'local', plan.local.length, false),
    ];
    // Remote only earns a row when something lives ONLY on the remote — a
    // branch you already have locally is represented by its local row, so
    // an empty Remote group is a heading over nothing. It starts closed
    // because expanding it is what pays for PR association.
    if (plan.remote.length > 0)
      rows.push(group('Remote', 'remote', plan.remote.length, false));
    // Landed appears only when there is something to clear. A permanent
    // "Landed · none" is the clutter the group exists to remove.
    if (plan.landed.length > 0)
      rows.push(group('Landed', 'landed', plan.landed.length, false));
    return rows;
  }

  /** The preview, or the row that offers to create it. */
  private previewRow(): TreeNode {
    const preview = this.worktrees.getPreview();
    if (!preview) {
      // What the removed panel's welcome content used to say — the one
      // place preview mode is discoverable while it is off.
      const row = new MessageItem(
        'Create Preview',
        'preview lanes merged together',
        'beaker',
      );
      row.command = {
        command: 'worktreeCompare.enablePreview',
        title: 'Enable Preview Mode',
      };
      return row;
    }
    return new PreviewItem(preview.branch, previewBaseRef(), {
      laneCount: preview.lanes.length,
      wip: preview.wip.some((l) => preview.lanes.includes(l)),
      error: preview.error,
      mergePaused: preview.mergePaused,
    });
  }

  /**
   * Lanes of the preview: base drift first (it is the base's own unlanded
   * work and merges before everything else), then the candidates in merge
   * order.
   *
   * LANDED lanes are dropped here. They retire themselves from the merge
   * automatically, and with Landed now a group in this same panel, leaving
   * a `landed`-tagged row under Preview would show the same branch twice in
   * one tree — the thing the ladder exists to prevent.
   */
  private laneRows(): TreeNode[] {
    const preview = this.worktrees.getPreview();
    if (!preview) return [];
    const rows: TreeNode[] = [];
    if (preview.baseDrift) {
      rows.push(
        new BaseDriftItem(
          previewBaseRef().replace(/^origin\//, ''),
          preview.baseDrift,
        ),
      );
    }
    const branchToPath = new Map(
      this.worktrees
        .getWorktrees()
        .filter((w) => !w.detached)
        .map((w) => [w.branch, w.path] as const),
    );
    const lanes = preview.candidates.filter(
      (b) => !preview.landed.includes(b),
    );
    if (lanes.length === 0) {
      return rows.length > 0
        ? rows
        : [
            new MessageItem(
              'No lanes yet',
              'add a checkout from Working to preview it here',
            ),
          ];
    }
    rows.push(
      ...lanes.map(
        (branch) =>
          new PreviewLaneItem(branch, preview.lanes.includes(branch), {
            conflicted:
              (preview.error?.code === 'conflict' &&
                preview.error.lane === branch) ||
              preview.conflicts.includes(branch),
            worktreePath: branchToPath.get(branch),
            wip: preview.wip.includes(branch),
            landed: false,
            resolving: preview.resolving.includes(branch),
            auto: !preview.explicit.includes(branch),
            autoResolved: preview.autoResolved.find(
              (r) => r.lane === branch,
            ),
          }),
      ),
    );
    return rows;
  }

  /**
   * Landed rows. A landed branch that still has a checkout renders as the
   * checkout — so the folder is visible and removable — while one that is
   * only a ref renders as a branch. Either way the row is the handle for
   * getting rid of it.
   */
  private landedRows(cwd: string, landed: LandedLane[]): TreeNode[] {
    if (landed.length === 0) return [new MessageItem('None')];
    return landed.map((lane) =>
      lane.worktree
        ? this.worktrees.buildCheckoutRow(lane.worktree, true)
        : new BranchItem(
            cwd,
            lane.branch,
            true,
            false,
            // No date: under Landed, "3 hours ago" is when it merged, which
            // reads as activity on something that is finished.
            '',
            undefined,
            this.branches.getPullRequestFor(lane.branch),
          ),
    );
  }

  private branchRows(
    cwd: string,
    list: ReturnType<BranchesTreeProvider['getBranches']>,
    hidden: number,
  ): TreeNode[] {
    if (list.length === 0) return [new MessageItem('None')];
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
          { ahead: b.ahead, behind: b.behind },
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
