import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileChange } from '../../git/compare';
import { worktreeFileUri } from '../worktreeDecorations';

/**
 * `ref` is a file of a focused branch with no checkout: both sides are
 * refs, so the diff is virtual and read-only.
 */
type FileDiffKind = 'vsBase' | 'vsHead' | 'commit' | 'ref';

/** Directory node under Full Diff tree layout. */
export class FolderItem extends vscode.TreeItem {
  readonly kind = 'folder' as const;

  constructor(
    readonly worktreePath: string,
    readonly baseRef: string,
    /** Posix path from worktree root */
    readonly folderPath: string,
    opts: {
      state?: vscode.TreeItemCollapsibleState;
      /**
       * Folded into the id. VS Code remembers expansion per id and ignores
       * `state` for one it has seen, so a new generation is what lets the
       * initial state apply again (see WorktreeTreeProvider.layoutGeneration).
       */
      generation?: number;
    } = {},
  ) {
    const name = path.posix.basename(folderPath);
    super(name, opts.state ?? vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `squashFolder:${opts.generation ?? 0}:${worktreePath}:${folderPath}`;
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
  /** The two sides of a `ref` diff: fork point ↔ branch tip. */
  readonly refs?: { left: string; right: string };

  constructor(
    readonly worktreePath: string,
    readonly baseRef: string,
    readonly file: FileChange,
    opts: {
      diffKind: FileDiffKind;
      commitHash?: string;
      statusSide?: 'staged' | 'unstaged';
      refs?: { left: string; right: string };
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
    this.refs = opts.refs;
    this.contextValue =
      opts.diffKind === 'commit'
        ? 'commitFile'
        : opts.diffKind === 'ref'
          ? 'refFile'
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
