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
import {
  formatRemotePrDescription,
  type RemotePullRequest,
} from '../github/remotePrs';
import { worktreeFileUri, worktreeResourceUri } from './worktreeDecorations';

export type FileDiffKind = 'vsBase' | 'vsHead' | 'commit' | 'remotePr';

export type TreeNode =
  | GroupItem
  | WorktreeListItem
  | ConflictWarningItem
  | CommitItem
  | SectionItem
  | FolderItem
  | FileItem
  | RemotePrItem
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
    readonly group: 'worktrees' | 'ahead',
    collapsible: vscode.TreeItemCollapsibleState,
    description?: string,
    opts?: { worktreePath?: string; baseRef?: string },
  ) {
    super(label, collapsible);
    this.contextValue = `group:${group}`;
    this.description = description;
    this.worktreePath = opts?.worktreePath;
    this.baseRef = opts?.baseRef;
    this.iconPath =
      group === 'worktrees'
        ? new vscode.ThemeIcon('repo')
        : new vscode.ThemeIcon('git-commit');
  }
}

/** One open PR from GitHub — expand for read-only files; checkout via context menu. */
export class RemotePrItem extends vscode.TreeItem {
  readonly kind = 'remotePr' as const;

  constructor(
    readonly pr: RemotePullRequest,
    readonly repoCwd: string,
  ) {
    super(
      `#${pr.number} ${pr.title}`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.contextValue = pr.hasLocalWorktree
      ? 'remotePrLocal'
      : 'remotePr';
    this.description = formatRemotePrDescription(pr);
    this.iconPath = prThemeIcon(pr);
    this.tooltip = [
      `PR #${pr.number}: ${pr.title}`,
      pr.authorLogin ? `Author: ${pr.authorLogin}` : undefined,
      pr.baseRefName && pr.headRefName
        ? `${pr.baseRefName} ← ${pr.headRefName}`
        : undefined,
      typeof pr.additions === 'number' && typeof pr.deletions === 'number'
        ? `+${pr.additions} / −${pr.deletions}`
        : undefined,
      pr.hasLocalWorktree
        ? 'Local worktree exists for this branch'
        : 'Read-only — expand files, or Create Worktree to edit',
      pr.url,
    ]
      .filter(Boolean)
      .join('\n');
    // No default command — expand for files; open GitHub via context menu
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

/** How a worktree row relates to the integration overlay (focus/working). */
export interface IntegrationRowInfo {
  role: 'integration' | 'lane';
  /** integration role: lanes currently merged in */
  lanes?: string[];
  /** integration role: last rebuild failure to surface */
  error?: string;
  /** integration role: a lane merge conflicted; tree left mid-merge */
  conflict?: boolean;
  /** lane role: branch is in the applied set */
  applied?: boolean;
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
    if (integration?.role === 'integration') {
      flags.push('Integration');
      if (integration.conflict) {
        flags.push('IntegrationConflict');
      }
    } else if (integration?.role === 'lane') {
      flags.push(integration.applied ? 'LaneApplied' : 'LaneAppliable');
    }
    const baseCtx = selected ? 'worktreeListItemActive' : 'worktreeListItem';
    this.contextValue =
      flags.length > 0 ? `${baseCtx}${flags.join('')}` : baseCtx;

    // Locked takes icon priority so the padlock is visible; else PR / branch
    if (integration?.role === 'integration') {
      this.iconPath = new vscode.ThemeIcon(
        integration.conflict || integration.error ? 'warning' : 'combine',
        integration.conflict || integration.error
          ? new vscode.ThemeColor('list.errorForeground')
          : selected
            ? new vscode.ThemeColor('charts.blue')
            : undefined,
      );
    } else if (worktree.locked) {
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
    if (integration?.role === 'integration') {
      if (integration.conflict) {
        bits.push('merge conflict');
      } else if (integration.error) {
        bits.push('rebuild failed');
      } else {
        const lanes = integration.lanes ?? [];
        bits.push(
          lanes.length > 0 ? `integration · ${lanes.join(', ')}` : 'integration · no lanes',
        );
      }
    } else if (integration?.role === 'lane' && integration.applied) {
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
      integration?.role === 'integration'
        ? `Integration checkout — rebuilt as base + applied lanes${
            (integration.lanes?.length ?? 0) > 0
              ? `: ${integration.lanes!.join(', ')}`
              : ' (none applied)'
          }`
        : undefined,
      integration?.role === 'integration' && integration.error
        ? `Last rebuild: ${integration.error}`
        : undefined,
      integration?.role === 'lane' && integration.applied
        ? 'Applied to the integration worktree'
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
