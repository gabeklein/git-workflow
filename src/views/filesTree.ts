import * as path from 'node:path';
import * as vscode from 'vscode';
import { git } from '../git/exec';
import { childrenAtPrefix, joinPrefix } from './fileTree';
import { isPathInside } from './pathFilters';
import type { WorktreeTreeProvider } from './worktreeTree';

/**
 * Explorer for the FOCUSED worktree: browse and open its files as real,
 * editable buffers — no diffs, no folder-swapping. A custom panel instead
 * of workspace.updateWorkspaceFolders because converting a single-folder
 * window to multi-root restarts the extension host (session-destroying).
 *
 * Listing comes from git (tracked + untracked, .gitignore respected), so
 * node_modules/build noise never renders; deleted-but-tracked paths are
 * subtracted. Levels expand lazily from one cached path list per
 * selection, invalidated on git activity and file create/delete/rename.
 */

export class ExplorerFileItem extends vscode.TreeItem {
  readonly kind = 'explorerFile' as const;

  constructor(readonly worktreePath: string, relPath: string) {
    super(path.posix.basename(relPath), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = vscode.Uri.file(path.join(worktreePath, relPath));
    this.contextValue = 'explorerFile';
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [this.resourceUri],
    };
  }
}

export class ExplorerFolderItem extends vscode.TreeItem {
  readonly kind = 'explorerFolder' as const;

  constructor(
    readonly worktreePath: string,
    readonly relPath: string,
  ) {
    super(
      path.posix.basename(relPath),
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.resourceUri = vscode.Uri.file(path.join(worktreePath, relPath));
    this.contextValue = 'explorerFolder';
  }
}

class ExplorerMessageItem extends vscode.TreeItem {
  readonly kind = 'explorerMessage' as const;

  constructor(message: string, detail?: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.description = detail;
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

export type ExplorerNode =
  | ExplorerFileItem
  | ExplorerFolderItem
  | ExplorerMessageItem;

export class FilesTreeProvider
  implements vscode.TreeDataProvider<ExplorerNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ExplorerNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];

  /** Path list for the currently listed worktree (single-entry cache). */
  private cache: { worktreePath: string; files: { path: string }[] } | null =
    null;

  constructor(private readonly worktrees: WorktreeTreeProvider) {
    const refreshIfUnderSelected = (uris: readonly vscode.Uri[]) => {
      const selected = this.worktrees.getSelectedPath();
      if (
        selected &&
        uris.some(
          (u) => u.scheme === 'file' && isPathInside(u.fsPath, selected),
        )
      ) {
        this.refresh();
      }
    };
    this.disposables.push(
      // Selection change (and discovery churn) — relist
      worktrees.onDidChangeWorktrees(() => this.refresh()),
      // Commits/checkouts/rebuilds anywhere — cheap, listing is lazy
      worktrees.onGitActivity(() => this.refresh()),
      vscode.workspace.onDidCreateFiles((e) => refreshIfUnderSelected(e.files)),
      vscode.workspace.onDidDeleteFiles((e) => refreshIfUnderSelected(e.files)),
      vscode.workspace.onDidRenameFiles((e) =>
        refreshIfUnderSelected(e.files.flatMap((f) => [f.oldUri, f.newUri])),
      ),
    );
  }

  refresh(): void {
    this.cache = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ExplorerNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> {
    const selected = this.worktrees.getSelectedPath();
    if (!selected) {
      return element ? [] : [new ExplorerMessageItem('Select a worktree above')];
    }
    if (element && element.kind !== 'explorerFolder') {
      return [];
    }
    let files: { path: string }[];
    try {
      files = await this.listFiles(selected);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return element ? [] : [new ExplorerMessageItem('Could not list files', message)];
    }
    if (!element && files.length === 0) {
      return [new ExplorerMessageItem('No files', 'empty worktree')];
    }
    const prefix = element ? element.relPath : '';
    const level = childrenAtPrefix(files, prefix);
    return [
      ...level.dirs.map(
        (d) => new ExplorerFolderItem(selected, joinPrefix(prefix, d)),
      ),
      ...level.files.map((f) => new ExplorerFileItem(selected, f.path)),
    ];
  }

  private async listFiles(
    worktreePath: string,
  ): Promise<{ path: string }[]> {
    if (this.cache?.worktreePath === worktreePath) {
      return this.cache.files;
    }
    const listed = (
      await git(worktreePath, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--deduplicate',
      ])
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // Tracked-but-deleted paths still appear in --cached — drop them
    const deleted = new Set(
      (await git(worktreePath, ['ls-files', '--deleted']).catch(() => ''))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const files = listed
      .filter((p) => !deleted.has(p))
      .map((p) => ({ path: p }));
    this.cache = { worktreePath, files };
    return files;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
