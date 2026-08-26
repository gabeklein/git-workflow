import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommitInfo, FileChange } from '../git/compare';
import type { DiscoveredWorktree } from '../discovery/scanner';
import {
  formatPrDescription,
  prHasMergeConflicts,
  prThemeIcon,
  type PullRequestInfo,
} from '../github/pr';
import type { RemotePullRequest } from '../github/remotePrs';
import { worktreeFileUri, worktreeResourceUri } from './worktreeDecorations';

export type FileDiffKind = 'vsBase' | 'vsHead' | 'commit' | 'remotePr';

export type TreeNode =
  | GroupItem
  | BaseDriftItem
  | IntegrationLaneItem
  | WorktreeListItem
  | ConflictWarningItem
  | CommitItem
  | SectionItem
  | FolderItem
  | FileItem
  | BranchItem
  | RemotePrFileItem
  | MessageItem;

/** Top-level collapsible group (Worktrees list / Commits ahead). */
export class GroupItem extends vscode.TreeItem {
  readonly kind = 'group' as const;
  /** Set on Commits group so Change Base Ref knows which worktree. */
  readonly worktreePath?: string;
  readonly baseRef?: string;

  constructor(
    label: string,
    readonly group: 'worktrees' | 'ahead' | 'branches' | 'remote',
    collapsible: vscode.TreeItemCollapsibleState,
    description?: string,
    opts?: { worktreePath?: string; baseRef?: string },
  ) {
    super(label, collapsible);
    this.contextValue = `group:${group}`;
    this.description = description;
    this.worktreePath = opts?.worktreePath;
    this.baseRef = opts?.baseRef;
    this.iconPath = new vscode.ThemeIcon(
      group === 'worktrees'
        ? 'repo'
        : group === 'ahead'
          ? 'git-commit'
          : group === 'branches'
            ? 'git-branch'
            : 'cloud',
    );
  }
}

/**
 * One branch in the Branches panel — local, remote, or PR-only, with
 * recency and status tags. Rows with a PR expand into read-only PR files.
 */
export class BranchItem extends vscode.TreeItem {
  readonly kind = 'branch' as const;

  constructor(
    readonly repoCwd: string,
    readonly branch: string,
    readonly hasLocalRef: boolean,
    readonly hasRemote: boolean,
    relativeDate: string,
    readonly worktreePath?: string,
    readonly pr?: RemotePullRequest,
  ) {
    super(
      branch,
      pr
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    const flags = [
      worktreePath ? 'HasWorktree' : 'NoWorktree',
      pr ? 'WithPr' : '',
    ].join('');
    this.contextValue = `branch${flags}`;

    const tags: string[] = [];
    if (relativeDate) {
      tags.push(relativeDate);
    }
    if (worktreePath) {
      tags.push('worktree');
    }
    if (pr) {
      tags.push(`PR #${pr.number}${pr.isDraft ? ' draft' : ''}`);
      if (pr.mergeable === 'CONFLICTING') {
        tags.push('conflicts');
      }
    }
    if (!hasLocalRef && (hasRemote || pr)) {
      tags.push('remote');
    } else if (hasLocalRef && !hasRemote && !pr) {
      tags.push('local only');
    }
    this.description = tags.join(' · ');

    const conflicting = pr?.mergeable === 'CONFLICTING';
    this.iconPath = pr
      ? prThemeIcon(pr)
      : !hasLocalRef
        ? new vscode.ThemeIcon('cloud')
        : new vscode.ThemeIcon(
            'git-branch',
            worktreePath ? new vscode.ThemeColor('charts.blue') : undefined,
          );

    this.tooltip = [
      branch,
      worktreePath ? `Worktree: ${worktreePath}` : 'No worktree — create one via context menu',
      pr ? `PR #${pr.number}: ${pr.title}` : undefined,
      pr?.authorLogin ? `Author: ${pr.authorLogin}` : undefined,
      conflicting ? 'GitHub reports merge conflicts with the PR base.' : undefined,
      !hasLocalRef && hasRemote ? 'Remote-tracking only (origin)' : undefined,
      !hasLocalRef && !hasRemote && pr ? 'PR head only — fetched on demand' : undefined,
      pr?.url,
    ]
      .filter((x): x is string => Boolean(x))
      .join('\n');

    if (worktreePath) {
      this.command = {
        command: 'worktreeCompare.focusWorktree',
        title: 'Focus Worktree',
        arguments: [worktreePath],
      };
    }
  }
}

/** Read-only file under a remote PR (virtual diff). */
export class RemotePrFileItem extends vscode.TreeItem {
  readonly kind = 'remotePrFile' as const;

  constructor(
    readonly repoCwd: string,
    readonly pr: RemotePullRequest,
    readonly baseRef: string,
    readonly headRef: string,
    readonly file: FileChange,
  ) {
    const basename = path.posix.basename(file.path);
    const dir = path.posix.dirname(file.path);
    super(basename, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'remotePrFile';
    this.description =
      dir === '.' ? file.status : `${dir}  ${file.status}`;
    this.iconPath = vscode.ThemeIcon.File;
    this.tooltip = `${file.status}  ${file.path}\nRead-only (PR #${pr.number})`;
    this.command = {
      command: 'worktreeCompare.openRemotePrFile',
      title: 'Open Read-only Diff',
      arguments: [this],
    };
  }
}

/**
 * One candidate lane under the Integration row. Checked = the branch is
 * merged into the integration tree; unchecked = candidate only.
 */
/**
 * Local <base> moved past the frozen integration base. The preview
 * deliberately does NOT follow unpublished base movement — this row
 * offers the two exits: move the commits to a feature branch (they join
 * the preview as a lane) or catch the base up on purpose.
 */
/**
 * The base's unpushed commits, shown as a LANE: the frozen base defines
 * the floor, and everything unlanded — main's own local work included —
 * is a checkable lane. Checked by default (unpushed base work is almost
 * always meant to be seen); unchecking persists. Pushing lands it and the
 * row disappears.
 */
export class BaseDriftItem extends vscode.TreeItem {
  readonly kind = 'integrationBaseDrift' as const;

  constructor(
    readonly baseName: string,
    readonly drift: {
      ahead: number;
      sha: string;
      resetTo: string;
      included: boolean;
    },
  ) {
    super(baseName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'integrationBaseDrift';
    this.description = `+${drift.ahead} unpushed`;
    this.checkboxState = {
      state: drift.included
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: drift.included
        ? `${baseName}'s unpushed commits are merged into the preview — uncheck to leave them out (persists)`
        : `Merge ${baseName}'s unpushed commits into the preview`,
    };
    this.iconPath = new vscode.ThemeIcon(
      'repo',
      drift.included ? new vscode.ThemeColor('charts.yellow') : undefined,
    );
    this.tooltip = [
      `${baseName} has ${drift.ahead} unpushed commit(s). The integration base stays frozen — unpushed base work is unlanded work, so it rides along as a lane instead of silently becoming the floor.`,
      '',
      drift.included
        ? 'Included in the preview. Uncheck to leave it out (the choice persists across future commits).'
        : 'Excluded from the preview. Check to merge it in.',
      'Pushing the base lands it — the frozen base advances and this row disappears.',
      'Context menu: Move New Base Commits to a Branch… (make it real feature work) · Catch Up Integration Base (make it the floor on purpose).',
    ].join('\n');
  }
}

export class IntegrationLaneItem extends vscode.TreeItem {
  readonly kind = 'integrationLane' as const;

  constructor(
    readonly branch: string,
    readonly applied: boolean,
    opts?: {
      /** This lane failed the last rebuild (merge conflict) */
      conflicted?: boolean;
      /** Worktree checkout of this branch, for click-to-focus */
      worktreePath?: string;
      /** Lane branch no longer exists */
      missing?: boolean;
      /** Uncommitted edits from the checkout overlay into rebuilds */
      wip?: boolean;
      /** Lane tip is contained in the base — it landed */
      landed?: boolean;
      /** A base merge is paused in the lane's worktree */
      resolving?: boolean;
      /** Auto member (its base matches the integration base), or a lane
       *  applied outside the extension — not an explicit add. */
      auto?: boolean;
      /** The last rebuild resolved this lane's clashes instead of failing. */
      autoResolved?: { lossless: string[]; lossy: string[] };
    },
  ) {
    super(branch, vscode.TreeItemCollapsibleState.None);
    // Wip toggle only offered for lanes that have a checkout
    const wipFlag = opts?.worktreePath
      ? opts?.wip
        ? 'WipOn'
        : 'WipOff'
      : '';
    // Resolve Conflict needs a checkout to run the merge in
    const conflictFlag = opts?.resolving
      ? 'Resolving'
      : opts?.conflicted && opts?.worktreePath
        ? 'Conflicted'
        : '';
    this.contextValue = `${applied ? 'integrationLaneApplied' : 'integrationLane'}${wipFlag}${conflictFlag}`;
    this.checkboxState = {
      state: applied
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: applied
        ? `${branch} is merged into the integration tree — uncheck to remove`
        : `Merge ${branch} into the integration tree`,
    };
    if (opts?.resolving) {
      this.description = 'resolving merge';
      this.iconPath = new vscode.ThemeIcon(
        'git-merge',
        new vscode.ThemeColor('charts.orange'),
      );
    } else if (opts?.conflicted) {
      this.description = opts?.wip ? 'conflict · +wip' : 'conflict';
      this.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('list.errorForeground'),
      );
    } else if (opts?.landed) {
      this.description = 'landed';
      this.iconPath = new vscode.ThemeIcon(
        'pass-filled',
        new vscode.ThemeColor('charts.green'),
      );
    } else if (opts?.autoResolved && opts.autoResolved.lossy.length > 0) {
      // Lossless resolutions stay silent — they are what a human would
      // have done. Dropped hunks are never silent.
      this.description = opts?.wip ? 'auto-resolved · +wip' : 'auto-resolved';
      this.iconPath = new vscode.ThemeIcon(
        'git-merge',
        new vscode.ThemeColor('charts.yellow'),
      );
    } else if (opts?.wip) {
      this.description = '+wip';
      this.iconPath = new vscode.ThemeIcon(
        'edit',
        applied ? new vscode.ThemeColor('charts.yellow') : undefined,
      );
    } else if (opts?.missing) {
      this.description = 'branch missing';
      this.iconPath = new vscode.ThemeIcon(
        'question',
        new vscode.ThemeColor('disabledForeground'),
      );
    } else {
      this.iconPath = new vscode.ThemeIcon('git-branch');
    }
    this.tooltip = [
      branch,
      applied
        ? 'Applied — merged into the integration tree (landed commits only).'
        : 'Candidate — check to merge its landed commits in.',
      opts?.resolving
        ? 'A base merge is paused in the lane worktree — resolve the markers, then Complete Merge from Base.'
        : opts?.conflicted
          ? 'This lane conflicts with the base; the checkout was left untouched. Resolve Conflict with Base starts the fix in the lane worktree.'
          : undefined,
      opts?.wip
        ? 'Working-tree edits included: uncommitted changes from the checkout overlay into rebuilds (saves in VS Code re-trigger).'
        : undefined,
      opts?.landed
        ? 'Landed — merging this lane into the base changes nothing. Safe to remove this row and delete the branch/worktree.'
        : undefined,
      opts?.missing ? 'The branch no longer exists.' : undefined,
      opts?.autoResolved && opts.autoResolved.lossy.length > 0
        ? `Auto-resolved lane-wins (clashing hunks from the other side were dropped): ${opts.autoResolved.lossy.join(', ')}. Catch the lane up with its base to make this exact.`
        : undefined,
      opts?.autoResolved &&
      opts.autoResolved.lossy.length === 0 &&
      opts.autoResolved.lossless.length > 0
        ? `Clashes auto-resolved losslessly (both sides kept): ${opts.autoResolved.lossless.join(', ')}.`
        : undefined,
      opts?.auto
        ? 'Auto member — its base matches the integration base. Remove from Integration hides it until it is added back.'
        : undefined,
    ]
      .filter((x): x is string => Boolean(x))
      .join('\n');
    if (opts?.worktreePath) {
      this.command = {
        command: 'worktreeCompare.focusWorktree',
        title: 'Focus Worktree',
        arguments: [opts.worktreePath],
      };
    }
  }
}

/** How a worktree row relates to the integration overlay (focus/working). */
export interface IntegrationRowInfo {
  role: 'lane';
  /** Branch is in the applied set */
  applied?: boolean;
  /** Branch is offered under the Integration row */
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
    integration?: IntegrationRowInfo,
    baseStatus?: {
      behind: number;
      conflicts: boolean;
      rebasing?: boolean;
      merging?: boolean;
      baseRef: string;
    },
  ) {
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
    if (pullRequest) {
      flags.push('WithPr');
    }
    if (worktree.locked) {
      flags.push('Locked');
    }
    const removable =
      !worktree.isRootCheckout && worktree.isMainWorktree !== true;
    if (removable) {
      flags.push('Removable');
    }
    if (integration?.role === 'lane') {
      // Candidates are managed under the Integration row; here only add/remove
      flags.push(integration.candidate ? 'LaneCandidate' : 'LaneAddable');
    }
    if (baseStatus?.rebasing) {
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

    const bits: string[] = [];
    // Selection is shown via blue decoration tint only (no "selected" label)
    if (baseStatus?.rebasing) {
      bits.push('rebasing');
    } else if (baseStatus?.merging) {
      bits.push('merging base');
    } else if (baseStatus?.conflicts) {
      bits.push(`conflicts with ${baseStatus.baseRef}`);
    } else if (baseStatus && baseStatus.behind > 0) {
      bits.push(`${baseStatus.behind} behind ${baseStatus.baseRef}`);
    }
    if (integration?.role === 'lane' && integration.applied) {
      bits.push('applied');
    }
    if (worktree.isRootCheckout) {
      bits.push(worktree.isDirty ? 'root · dirty' : 'root');
    }
    if (worktree.locked) {
      bits.push('locked');
    }
    if (pullRequest) {
      bits.push(formatPrDescription(pullRequest));
    } else if (worktree.publishState) {
      // No PR: show whether branch exists on a remote
      bits.push(worktree.publishState);
    }
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
      integration?.role === 'lane' && integration.applied
        ? 'Applied to the integration worktree'
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
      if (prHasMergeConflicts(pullRequest)) {
        tip.push('GitHub reports merge conflicts with the PR base.');
      }
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
 * (We no longer warn merely because the integration tip moved ahead.)
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
      new vscode.ThemeColor('list.errorForeground'),
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

export class SectionItem extends vscode.TreeItem {
  readonly kind = 'section' as const;

  constructor(
    label: string,
    readonly section: 'staged' | 'unstaged' | 'squash',
    readonly worktreePath: string,
    readonly baseRef: string,
    collapsible: vscode.TreeItemCollapsibleState,
    description?: string,
  ) {
    super(label, collapsible);
    this.contextValue = `section:${section}`;
    this.description = description;
    if (section === 'staged') {
      this.iconPath = new vscode.ThemeIcon('check');
    } else if (section === 'unstaged') {
      this.iconPath = new vscode.ThemeIcon('request-changes');
    } else {
      // Full Diff = cumulative WT ↔ base file set
      this.iconPath = new vscode.ThemeIcon('git-pull-request');
    }
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

/** Directory node under Full Diff tree layout. */
export class FolderItem extends vscode.TreeItem {
  readonly kind = 'folder' as const;

  constructor(
    readonly worktreePath: string,
    readonly baseRef: string,
    /** Posix path from worktree root */
    readonly folderPath: string,
  ) {
    const name = path.posix.basename(folderPath);
    super(name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'squashFolder';
    this.iconPath = vscode.ThemeIcon.Folder;
    this.resourceUri = worktreeFileUri(
      path.join(worktreePath, ...folderPath.split('/')),
    );
    this.tooltip = folderPath;
  }
}

export class FileItem extends vscode.TreeItem {
  readonly kind = 'file' as const;
  readonly diffKind: FileDiffKind;
  readonly commitHash?: string;
  readonly statusSide?: 'staged' | 'unstaged';

  constructor(
    readonly worktreePath: string,
    readonly baseRef: string,
    readonly file: FileChange,
    opts: {
      diffKind: FileDiffKind;
      commitHash?: string;
      statusSide?: 'staged' | 'unstaged';
      /** Tree layout: status letter only (path is in folder hierarchy) */
      treeLayout?: boolean;
    },
  ) {
    const basename = path.posix.basename(file.path);
    const dir = path.posix.dirname(file.path);
    super(basename, vscode.TreeItemCollapsibleState.None);
    this.diffKind = opts.diffKind;
    this.commitHash = opts.commitHash;
    this.statusSide = opts.statusSide;
    this.contextValue =
      opts.diffKind === 'commit'
        ? 'commitFile'
        : opts.diffKind === 'vsBase'
          ? 'squashFile'
          : opts.statusSide === 'staged'
            ? 'stagedFile'
            : opts.statusSide === 'unstaged'
              ? 'unstagedFile'
              : 'workingFile';

    // Icon theme keys off the path; fake scheme avoids git/GitLens repo-open
    this.resourceUri = worktreeFileUri(
      path.join(worktreePath, ...file.path.split('/')),
    );
    this.iconPath = vscode.ThemeIcon.File;

    // SCM-style status letter on the right
    const letter = statusLetter(file.status);
    if (opts.treeLayout) {
      this.description = letter;
    } else {
      this.description = dir === '.' ? letter : `${dir}  ${letter}`;
    }

    this.command = {
      command: 'worktreeCompare.openFileDiff',
      title: 'Open Diff',
      arguments: [this],
    };
    this.tooltip = `${statusLabel(file.status)} (${letter})  ${file.path}`;
  }
}

export class MessageItem extends vscode.TreeItem {
  readonly kind = 'message' as const;

  constructor(label: string, description?: string, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'message';
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

/** Single-letter badge like native SCM (M / A / D / R / U / …). */
function statusLetter(status: string): string {
  switch (status) {
    case '?':
      return 'U'; // untracked
    case 'A':
    case 'M':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
    case 'U':
      return status;
    default:
      return status || 'M';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case '?':
      return 'Untracked';
    case 'A':
      return 'Added';
    case 'D':
      return 'Deleted';
    case 'R':
      return 'Renamed';
    case 'C':
      return 'Copied';
    case 'M':
      return 'Modified';
    case 'T':
      return 'Type changed';
    case 'U':
      return 'Unmerged';
    default:
      return status;
  }
}
