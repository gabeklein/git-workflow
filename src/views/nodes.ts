import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommitInfo, FileChange } from '../git/compare';
import type { DiscoveredWorktree } from '../discovery/scanner';

export type FileDiffKind = 'vsBase' | 'vsHead' | 'commit';

export type TreeNode =
  | WorktreeItem
  | BehindWarningItem
  | CommitItem
  | SectionItem
  | FileItem
  | MessageItem;

export class WorktreeItem extends vscode.TreeItem {
  readonly kind = 'worktree' as const;
  readonly worktreePath: string;
  readonly worktree: DiscoveredWorktree;

  constructor(worktree: DiscoveredWorktree) {
    const branchLabel =
      worktree.branch + (worktree.detached ? ' (detached)' : '');
    super(branchLabel, vscode.TreeItemCollapsibleState.Collapsed);
    this.worktree = worktree;
    this.worktreePath = worktree.path;
    this.contextValue = 'worktree';
    this.iconPath = new vscode.ThemeIcon(
      worktree.detached ? 'git-commit' : 'git-branch',
    );
    this.tooltip = [
      branchLabel,
      `Worktree: ${worktree.name}`,
      `Path: ${worktree.path}`,
      worktree.relativePath ? `Relative: ${worktree.relativePath}` : '',
    ]
      .filter(Boolean)
      .join('\n');
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
    readonly section: 'staged' | 'changes' | 'fullPr',
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
    // Secondary label on the right (TreeItem has no "description only on hover").
    // Full SHA stays on Copy Commit SHA; author is available on tooltip.
    this.description = commit.relativeDate || undefined;
    this.tooltip = commit.author
      ? `${commit.relativeDate || ''}${commit.relativeDate ? ' · ' : ''}${commit.author}`.trim()
      : commit.relativeDate || undefined;
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
          ? 'fullPrFile'
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
