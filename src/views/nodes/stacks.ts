import * as vscode from 'vscode';
import type { StackCommit } from '../../git/stacks';

/**
 * Rows of the stacks layout that have no counterpart in the groups one.
 * Branch rows are not here: they reuse BranchItem and WorktreeListItem, so
 * every context menu keyed on those keeps working, and carry a `stack`
 * field saying where they sit (see StackRowInfo).
 */

/** What a branch row in the stacks layout carries beyond its base class. */
export interface StackRowInfo {
  branch: string;
  /** What git resolves: the local name, `origin/<b>`, or a detached sha. */
  ref: string;
  /** What Focus measures it against: its parent branch, or the trunk. */
  base: string;
  worktreePath?: string;
  /** Own commits, oldest first. */
  commits: StackCommit[];
  /** Preview membership is offered (a local ref, preview on). */
  checkable: boolean;
}

/** The trunk everything leads into; selecting it browses its history in Focus. */
export class TrunkItem extends vscode.TreeItem {
  readonly kind = 'trunk' as const;

  constructor(
    readonly repoCwd: string,
    readonly ref: string,
  ) {
    super(ref, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'trunk';
    this.id = 'stack:trunk';
    this.iconPath = new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('charts.green'));
    this.tooltip = `${ref} — the trunk every branch below leads into. Select to browse its history.`;
  }
}

/** Older trunk history in Focus, fetched on request rather than up front. */
export class LoadMoreItem extends vscode.TreeItem {
  readonly kind = 'loadMore' as const;

  constructor() {
    super('Load more', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'loadMore';
    this.iconPath = new vscode.ThemeIcon('fold-down');
    this.command = { command: 'worktreeCompare.loadMoreTrunk', title: 'Load More' };
  }
}

/** Stacks folded out of the way: Older (local, quiet) or Remote (not local). */
export class StackGroupItem extends vscode.TreeItem {
  readonly kind = 'stackGroup' as const;

  constructor(
    readonly group: 'Older' | 'Remote',
    count: number,
    hint: string,
  ) {
    super(group, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'stackGroup';
    this.description = `${count} · ${hint}`;
    this.iconPath = new vscode.ThemeIcon(group === 'Remote' ? 'cloud' : 'history');
    this.id = `stack-group:${group}`;
  }
}
