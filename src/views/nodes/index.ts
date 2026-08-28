import * as vscode from 'vscode';
import type { BranchItem, RemotePrFileItem } from './branches';
import type { FileItem, FolderItem } from './files';
import type { BaseDriftItem, PreviewLaneItem, PreviewItem } from './lanes';
import type {
  CommitItem,
  ConflictWarningItem,
  WorktreeListItem,
} from './worktrees';

/**
 * Every row any of the panels can render, and the three that belong to no
 * panel in particular: a collapsible group, a section header inside one,
 * and the placeholder shown when a group has nothing to say.
 *
 * Rows are plain `TreeItem` subclasses, one per kind, each tagged with a
 * literal `kind` so a provider can switch on what it was handed. The rest
 * live beside the panel they are rendered by.
 */
export type TreeNode =
  | GroupItem
  | BaseDriftItem
  | PreviewLaneItem
  | WorktreeListItem
  | ConflictWarningItem
  | PreviewItem
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
    readonly group:
      | 'preview'
      | 'working'
      | 'local'
      | 'remote'
      | 'landed'
      | 'ahead'
      | 'directory',
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
      group === 'preview'
        ? 'beaker'
        : group === 'working'
        ? 'repo'
        : group === 'ahead'
          ? 'git-commit'
          : group === 'local'
            ? 'git-branch'
            : group === 'directory'
              ? 'folder-opened'
              : group === 'landed'
                ? 'check-all'
                : 'cloud',
    );
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

export class MessageItem extends vscode.TreeItem {
  readonly kind = 'message' as const;

  constructor(label: string, description?: string, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'message';
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}
