import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileChange } from '../../git/compare';
import { prThemeIcon } from '../../github/pr';
import type { RemotePullRequest } from '../../github/remotePrs';
import { branchResourceUri } from '../worktreeDecorations';

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
    /** Divergence from its upstream, when it has one. */
    sync?: { ahead?: number; behind?: number },
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
    // Lets the row carry the preview-membership badge; the icon is set
    // explicitly below, so this never drives file-icon theming.
    this.resourceUri = branchResourceUri(branch);

    // Same rule as checkout rows: the PR number leads, because it is what
    // identifies the row and descriptions truncate from the right.
    const tags: string[] = [];
    if (pr) {
      tags.push(`PR #${pr.number}${pr.isDraft ? ' draft' : ''}`);
      if (pr.mergeable === 'CONFLICTING') tags.push('conflicts');
    }
    if (worktreePath) tags.push('worktree');
    // Sync state as a badge, which is why a branch that exists both here
    // and on the remote is ONE row rather than two: ↑ is yours to push, ↓
    // is theirs to pull. Absent when there is no upstream to compare with —
    // an unpublished branch is not "ahead" of anything.
    const arrows = [
      sync?.ahead ? `↑${sync.ahead}` : '',
      sync?.behind ? `↓${sync.behind}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (arrows) tags.push(arrows);
    if (!hasLocalRef && (hasRemote || pr)) tags.push('remote');
    // 'local only' says nothing: under Branches it is the default state.
    // The date goes LAST so it trails the row — the tree has no
    // right-aligned field, and the one right-edge slot (the decoration
    // badge) is spent marking preview membership.
    if (relativeDate) tags.push(relativeDate);
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
