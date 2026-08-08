import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommitInfo, FileChange } from '../git/compare';
import type { DiscoveredWorktree } from '../discovery/scanner';

export type TreeNode =
  | WorktreeItem
  | CompareRootItem
  | SectionItem
  | CommitItem
  | FileItem
  | MessageItem;

export class WorktreeItem extends vscode.TreeItem {
  readonly kind = 'worktree' as const;
  readonly worktreePath: string;
  readonly worktree: DiscoveredWorktree;

  constructor(worktree: DiscoveredWorktree) {
    super(worktree.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.worktree = worktree;
    this.worktreePath = worktree.path;
    this.contextValue = 'worktree';
    this.iconPath = new vscode.ThemeIcon('repo');
    this.description = worktree.branch + (worktree.detached ? ' (detached)' : '');
    this.tooltip = new vscode.MarkdownString(
      [
        `**${worktree.name}**`,
        '',
        `Path: \`${worktree.path}\``,
        `Branch: \`${worktree.branch}\``,
        worktree.relativePath ? `Relative: \`${worktree.relativePath}\`` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

export class CompareRootItem extends vscode.TreeItem {
  readonly kind = 'compareRoot' as const;

  constructor(
    readonly worktreePath: string,
    readonly baseRef: string,
    readonly ahead: number,
    readonly behind: number,
  ) {
    super(
      `Comparing Working Tree with ${baseRef}`,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.contextValue = 'compareRoot';
    this.iconPath = new vscode.ThemeIcon('git-compare');
    this.description =
      ahead || behind ? `${ahead}↑ ${behind}↓` : '0↑ 0↓';
    this.tooltip = new vscode.MarkdownString(
      [
        `Comparing **Working Tree** with \`${baseRef}\``,
        '',
        'Click the compare icon or run **Change Base Ref** to pick another branch/tag.',
      ].join('\n'),
    );
  }
}

export class SectionItem extends vscode.TreeItem {
  readonly kind = 'section' as const;

  constructor(
    label: string,
    readonly section: 'behind' | 'ahead' | 'files',
    readonly worktreePath: string,
    readonly baseRef: string,
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed,
  ) {
    super(label, collapsible);
    this.contextValue = `section:${section}`;
    if (section === 'behind') {
      this.iconPath = new vscode.ThemeIcon('arrow-down');
    } else if (section === 'ahead') {
      this.iconPath = new vscode.ThemeIcon('arrow-up');
    } else {
      this.iconPath = new vscode.ThemeIcon('diff');
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
    this.description = `${commit.shortHash} · ${commit.relativeDate}`;
    this.tooltip = `${commit.subject}\n${commit.author} · ${commit.relativeDate}\n${commit.hash}`;
  }
}

export class FileItem extends vscode.TreeItem {
  readonly kind = 'file' as const;

  constructor(
    readonly worktreePath: string,
    readonly baseRef: string,
    readonly file: FileChange,
    /** When set, open commit-to-parent diff instead of working tree */
    readonly commitHash?: string,
  ) {
    const basename = path.posix.basename(file.path);
    const dir = path.posix.dirname(file.path);
    super(basename, vscode.TreeItemCollapsibleState.None);
    this.contextValue = commitHash ? 'commitFile' : 'workingFile';
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
      return new vscode.ThemeIcon('diff-added');
    case 'D':
      return new vscode.ThemeIcon('diff-removed');
    case 'R':
    case 'C':
      return new vscode.ThemeIcon('diff-renamed');
    default:
      return new vscode.ThemeIcon('diff-modified');
  }
}

function statusLabel(status: string): string {
  switch (status) {
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
    default:
      return status;
  }
}
