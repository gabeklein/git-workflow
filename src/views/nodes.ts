import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommitInfo, FileChange } from '../git/compare';
import type { DiscoveredWorktree } from '../discovery/scanner';

export type FileDiffKind = 'vsBase' | 'vsHead' | 'commit';

export type TreeNode =
  | GroupItem
  | WorktreeListItem
  | BehindWarningItem
  | CommitItem
  | SectionItem
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

  constructor(worktree: DiscoveredWorktree, selected: boolean) {
    const branchLabel =
      worktree.branch + (worktree.detached ? ' (detached)' : '');
    super(branchLabel, vscode.TreeItemCollapsibleState.None);
    this.worktreePath = worktree.path;
    this.description = worktree.name;
    this.contextValue = selected ? 'worktreeListItemActive' : 'worktreeListItem';
    this.iconPath = new vscode.ThemeIcon(
      selected ? 'circle-filled' : 'circle-outline',
    );
    this.tooltip = [
      branchLabel,
      `Folder: ${worktree.name}`,
      worktree.path,
      selected ? 'Selected' : 'Click to focus',
    ].join('\n');
    this.command = {
      command: 'worktreeCompare.focusWorktree',
      title: 'Focus Worktree',
      arguments: [this.worktreePath],
    };
  }
}

/** Soft warning when worktree tip is behind its compare base. */
export class BehindWarningItem extends vscode.TreeItem {
  readonly kind = 'behindWarning' as const;

  constructor(
    readonly worktreePath: string,
    readonly baseRef: string,
    readonly behind: number,
  ) {
    const n = behind;
    super(
      `Behind ${baseRef} (${n} commit${n === 1 ? '' : 's'})`,
      vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = 'behindWarning';
    this.iconPath = new vscode.ThemeIcon(
      'warning',
      new vscode.ThemeColor('list.warningForeground'),
    );
    this.description = 'rebase recommended';
    this.tooltip = [
      `This worktree is ${n} commit${n === 1 ? '' : 's'} behind ${baseRef}.`,
      'Browsing and editing still work. Consider rebasing (or merging) onto the base before adding more commits.',
      'Use Change Base Ref if the base is wrong.',
    ].join('\n');
    this.command = {
      command: 'worktreeCompare.changeBaseRef',
      title: 'Change Base Ref',
      arguments: [{ worktreePath, baseRef } satisfies { worktreePath: string; baseRef: string }],
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
      // Squashed = cumulative WT ↔ base file set
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
    this.description = dir === '.' ? undefined : dir;
    this.iconPath = statusIcon(file.status);
    this.resourceUri = vscode.Uri.file(
      path.join(worktreePath, ...file.path.split('/')),
    );
    this.command = {
      command: 'worktreeCompare.openFileDiff',
      title: 'Open Diff',
      arguments: [this],
    };
    this.tooltip = `${statusLabel(file.status)} ${file.path}`;
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

function statusIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case 'A':
    case '?':
      return new vscode.ThemeIcon('diff-added');
    case 'D':
      return new vscode.ThemeIcon('diff-removed');
    case 'R':
    case 'C':
      return new vscode.ThemeIcon('diff-renamed');
    case 'U':
      return new vscode.ThemeIcon('warning');
    default:
      return new vscode.ThemeIcon('diff-modified');
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'A':
    case '?':
      return 'Added';
    case 'D':
      return 'Deleted';
    case 'R':
      return 'Renamed';
    case 'C':
      return 'Copied';
    case 'M':
      return 'Modified';
    case 'U':
      return 'Unmerged';
    default:
      return status;
  }
}
