import * as vscode from 'vscode';
import type { CommitInfo } from '../../git/compare';
import type { DiscoveredWorktree } from '../../git/discovery';
import {
  formatPrDescription,
  prHasMergeConflicts,
  prThemeIcon,
  type PullRequestInfo,
} from '../../github/pr';
import {
  describeBlocker,
  explainBlocker,
  type LandedBlocker,
} from '../../git/landedWorktrees';
import { worktreeResourceUri } from '../worktreeDecorations';

/** How a worktree row relates to the preview overlay (focus/working). */
/**
 * A checkout whose branch has landed — the folder is still on disk, and
 * `blocker` is why the landed sweep left it there (`off` when automatic
 * removal is simply switched off). Present ONLY for landed checkouts, so
 * its presence is what the row renders on.
 */
export interface LandedRowInfo {
  branch: string;
  blocker: LandedBlocker;
}

export interface PreviewRowInfo {
  role: 'lane';
  /** Branch is in the applied set */
  applied?: boolean;
  /** Branch is offered under the Preview row */
  candidate?: boolean;
}

/** One row in the Worktrees group — click focuses the sections below. */
export class WorktreeListItem extends vscode.TreeItem {
  readonly kind = 'worktreeList' as const;
  readonly worktreePath: string;
  readonly pullRequest?: PullRequestInfo;

  constructor(
    worktree: DiscoveredWorktree,
    selected: boolean,
    pullRequest?: PullRequestInfo,
    preview?: PreviewRowInfo,
    baseStatus?: {
      behind: number;
      conflicts: boolean;
      rebasing?: boolean;
      merging?: boolean;
      baseRef: string;
    },
    /**
     * Set when the branch has LANDED and this folder is still on disk.
     *
     * The row then leads with that: it is the only fact about the checkout
     * worth acting on, and it replaces "behind the base", which after a
     * squash merge is both inevitable and unactionable — the branch is
     * behind by the very commit that landed it.
     */
    landedInfo?: LandedRowInfo,
  ) {
    const landed = Boolean(landedInfo);
    const branchLabel =
      worktree.branch + (worktree.detached ? ' (detached)' : '');
    // TreeItems cannot be font-bold; selected rows use blue decoration tint + badge
    super(branchLabel, vscode.TreeItemCollapsibleState.None);
    this.worktreePath = worktree.path;
    this.pullRequest = pullRequest;
    // Enables FileDecoration (blue tint + ●) for the selected row
    this.resourceUri = worktreeResourceUri(worktree.path);

    // Context flags for menus: WithPr, Locked, Removable (not main/root)
    const flags: string[] = [];
    if (pullRequest) flags.push('WithPr');
    if (worktree.locked) flags.push('Locked');
    const removable =
      !worktree.isRootCheckout && worktree.isMainWorktree !== true;
    if (removable) flags.push('Removable');
    if (preview?.role === 'lane') {
      // Candidates are managed under the Preview row; here only add/remove
      flags.push(preview.candidate ? 'LaneCandidate' : 'LaneAddable');
    }
    // Landed replaces the base-status flags for the same reason it replaces
    // their description text — and it gives the menu something to hang a
    // prominent Delete Worktree on.
    if (landedInfo) {
      flags.push('Landed');
    } else if (baseStatus?.rebasing) {
      flags.push('Rebasing');
    } else if (baseStatus?.merging) {
      flags.push('MergingBase');
    } else if (baseStatus?.conflicts) {
      flags.push('ConflictsBase');
    } else if (baseStatus && baseStatus.behind > 0) {
      flags.push('BehindBase');
    }
    const baseCtx = selected ? 'worktreeListItemActive' : 'worktreeListItem';
    this.contextValue =
      flags.length > 0 ? `${baseCtx}${flags.join('')}` : baseCtx;

    // Locked takes icon priority so the padlock is visible; else PR / branch
    if (worktree.locked) {
      this.iconPath = new vscode.ThemeIcon(
        'lock',
        new vscode.ThemeColor('list.warningForeground'),
      );
    } else if (pullRequest) {
      this.iconPath = prThemeIcon(pullRequest);
    } else if (worktree.isRootCheckout) {
      this.iconPath = new vscode.ThemeIcon(
        'repo',
        selected ? new vscode.ThemeColor('charts.blue') : undefined,
      );
    } else {
      this.iconPath = new vscode.ThemeIcon(
        'git-branch',
        selected ? new vscode.ThemeColor('charts.blue') : undefined,
      );
    }

    // The PR number goes FIRST. It is the row's most identifying fact — the
    // thing you match against a PR you are looking at — and descriptions
    // are truncated from the right, so anything ahead of it can push it out
    // of the panel entirely. That is exactly what `conflicts with
    // origin/main · #37 · conflicts` did.
    const bits: string[] = [];
    if (pullRequest) {
      // Under Landed the state word is redundant with the group; the
      // NUMBER is not, so keep that and drop the rest.
      bits.push(
        landed ? `#${pullRequest.number}` : formatPrDescription(pullRequest),
      );
    } else if (worktree.publishState && worktree.publishState !== 'local') {
      // No PR: worth saying only when the branch got somewhere — 'local' is
      // the default state of a checkout and reads as noise on every row.
      bits.push(worktree.publishState);
    }

    // Selection is shown via blue decoration tint only (no "selected" label)
    if (landedInfo) {
      // Why the folder is still here, which is the only actionable fact
      // left about it. Nothing else applies to a landed branch: it is
      // behind because it landed, and catching it up is not a thing
      // anyone wants to do.
      bits.push(describeBlocker(landedInfo.blocker));
    } else if (baseStatus?.rebasing) {
      bits.push('rebasing');
    } else if (baseStatus?.merging) {
      bits.push('merging base');
    } else if (baseStatus?.conflicts) {
      // Say "conflicts" once. When the PR already reports conflicts the
      // second mention adds a base name and a lot of width for something
      // the reader has just been told.
      if (!pullRequest || !prHasMergeConflicts(pullRequest))
        bits.push(`conflicts with ${baseStatus.baseRef}`);
    } else if (baseStatus && baseStatus.behind > 0) {
      bits.push(`${baseStatus.behind} behind ${baseStatus.baseRef}`);
    }

    if (worktree.isRootCheckout)
      bits.push(worktree.isDirty ? 'root · dirty' : 'root');
    if (worktree.locked) bits.push('locked');
    this.description = bits.length > 0 ? bits.join(' · ') : undefined;

    const rel =
      worktree.relativePath || worktree.name || worktree.path;
    const tip: string[] = [
      branchLabel,
      worktree.isRootCheckout ? `Root checkout (${rel})` : rel,
      worktree.isDirty ? 'Dirty working tree' : undefined,
      worktree.locked
        ? worktree.lockReason
          ? `Locked: ${worktree.lockReason}`
          : 'Locked (git worktree lock)'
        : undefined,
      preview?.role === 'lane' && preview.applied
        ? 'Applied to the preview'
        : undefined,
      landedInfo
        ? explainBlocker(landedInfo.blocker, landedInfo.branch)
        : undefined,
      baseStatus?.rebasing
        ? 'A rebase is paused here — resolve the conflicts, then Continue Rebase (or Abort Rebase).'
        : baseStatus?.merging
          ? 'A base merge is paused here — resolve the conflicts, then Complete Merge from Base (or abort).'
          : baseStatus?.conflicts
            ? `Rebasing/merging onto ${baseStatus.baseRef} would conflict — Catch Up with Base starts the fix here.`
            : baseStatus && baseStatus.behind > 0
              ? `${baseStatus.behind} commit(s) behind ${baseStatus.baseRef} — merges cleanly.`
              : undefined,
      selected ? 'Selected' : 'Click to focus',
    ].filter((x): x is string => Boolean(x));
    if (pullRequest) {
      tip.push(
        `PR #${pullRequest.number}: ${pullRequest.title}`,
        `${formatPrDescription(pullRequest)} · ${pullRequest.url}`,
      );
      if (prHasMergeConflicts(pullRequest))
        tip.push('GitHub reports merge conflicts with the PR base.');
    }
    this.tooltip = tip.join('\n');

    this.command = {
      command: 'worktreeCompare.focusWorktree',
      title: 'Focus Worktree',
      arguments: [this.worktreePath],
    };
  }
}

/**
 * Warning when GitHub reports the linked PR has merge conflicts.
 * (We no longer warn merely because the preview tip moved ahead.)
 */
export class ConflictWarningItem extends vscode.TreeItem {
  readonly kind = 'conflictWarning' as const;

  constructor(
    readonly worktreePath: string,
    readonly pullRequest: PullRequestInfo,
    readonly baseRef: string,
  ) {
    super(
      `PR #${pullRequest.number} has merge conflicts`,
      vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = 'conflictWarning';
    this.iconPath = new vscode.ThemeIcon(
      'warning',
      new vscode.ThemeColor('charts.red'),
    );
    this.description = pullRequest.baseRefName
      ? `vs ${pullRequest.baseRefName}`
      : 'resolve before merge';
    this.tooltip = [
      `GitHub: pull request #${pullRequest.number} conflicts with its base.`,
      pullRequest.title,
      pullRequest.url,
      baseRef ? `Local compare tip: ${baseRef}` : undefined,
      'Being behind the base is fine until conflicts appear — rebase/merge only if needed.',
    ]
      .filter(Boolean)
      .join('\n');
    this.command = {
      command: 'worktreeCompare.openPullRequest',
      title: 'Open Pull Request on GitHub',
      arguments: [{ worktreePath, pullRequest }],
    };
  }
}

export class CommitItem extends vscode.TreeItem {
  readonly kind = 'commit' as const;

  constructor(
    readonly worktreePath: string,
    readonly baseRef: string,
    readonly commit: CommitInfo,
  ) {
    super(commit.subject || commit.shortHash, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'commit';
    this.iconPath = new vscode.ThemeIcon('git-commit');
    // Time on the right; full subject + time + author on hover (narrow sidebars).
    this.description = commit.relativeDate || undefined;
    this.tooltip = [
      commit.subject || commit.shortHash,
      commit.relativeDate || undefined,
      commit.author ? commit.author : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }
}
