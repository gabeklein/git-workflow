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
import { worktreeResourceUri } from './worktreeDecorations';

export type FileDiffKind = 'vsBase' | 'vsHead' | 'commit';

export type TreeNode =
  | GroupItem
  | WorktreeListItem
  | ConflictWarningItem
  | CommitItem
  | SectionItem
  | FolderItem
  | FileItem
  | MessageItem;

/** Top-level collapsible group (Worktrees list / Ahead commits). */
export class GroupItem extends vscode.TreeItem {
  readonly kind = 'group' as const;

  constructor(
    label: string,
    readonly group: 'worktrees' | 'ahead',
    collapsible: vscode.TreeItemCollapsibleState,
    description?: string,
  ) {
    super(label, collapsible);
    this.contextValue = `group:${group}`;
    this.description = description;
    this.iconPath =
      group === 'worktrees'
        ? new vscode.ThemeIcon('repo')
        : new vscode.ThemeIcon('git-commit');
  }
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
    if (worktree.isRootCheckout) {
      bits.push(worktree.isDirty ? 'root · dirty' : 'root');
    }
    if (worktree.locked) {
      bits.push('locked');
    }
    if (pullRequest) {
      bits.push(formatPrDescription(pullRequest));
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
    readonly section: 'staged' | 'changes' | 'squash',
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
    } else if (section === 'changes') {
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
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'squashFolder';
    this.iconPath = vscode.ThemeIcon.Folder;
    this.resourceUri = vscode.Uri.file(
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

    // File-type icon from product/file icon theme
    this.resourceUri = vscode.Uri.file(
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
    case 'A':
      return 'Added';
    case '?':
      return 'Untracked';
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
