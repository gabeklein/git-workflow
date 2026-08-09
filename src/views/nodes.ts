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

  constructor(worktree: DiscoveredWorktree, selected: boolean) {
    const branchLabel =
      worktree.branch + (worktree.detached ? ' (detached)' : '');
    super(branchLabel, vscode.TreeItemCollapsibleState.None);
    this.worktreePath = worktree.path;
    // Branch only in the row; path on hover
    this.description = undefined;
    this.contextValue = selected ? 'worktreeListItemActive' : 'worktreeListItem';
    this.iconPath = new vscode.ThemeIcon(
      selected ? 'circle-filled' : 'circle-outline',
    );
    const rel =
      worktree.relativePath || worktree.name || worktree.path;
    this.tooltip = [
      branchLabel,
      worktree.isRootCheckout ? `Root checkout (${rel})` : rel,
      worktree.isDirty ? 'Dirty working tree' : undefined,
      selected ? 'Selected' : 'Click to focus',
    ]
      .filter(Boolean)
      .join('\n');
    // Subtle cue for root without cluttering the row with a folder name
    if (worktree.isRootCheckout) {
      this.description = worktree.isDirty ? 'root · dirty' : 'root';
    }
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

/** Directory node under Squashed tree layout. */
export class FolderItem extends vscode.TreeItem {
  readonly kind = 'folder' as const;

  constructor(
    readonly worktreePath: string,
    readonly baseRef: string,
    /** Posix path from worktree root */
    readonly folderPath: string,
    fileCount: number,
  ) {
    const name = path.posix.basename(folderPath);
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'squashFolder';
    this.iconPath = vscode.ThemeIcon.Folder;
    this.resourceUri = vscode.Uri.file(
      path.join(worktreePath, ...folderPath.split('/')),
    );
    this.description = fileCount > 0 ? String(fileCount) : undefined;
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
