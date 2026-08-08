import * as vscode from 'vscode';
import {
  discoverWorktrees,
  resolveWatchRoots,
  type DiscoveredWorktree,
} from '../discovery/scanner';
import {
  compareWorkingTreeToBase,
  listCommitFiles,
  type CompareResult,
} from '../git/compare';
import { resolveBaseRef } from '../git/worktree';
import {
  CommitItem,
  CompareRootItem,
  FileItem,
  MessageItem,
  SectionItem,
  type TreeNode,
  WorktreeItem,
} from './nodes';

export type { TreeNode } from './nodes';
export { FileItem, WorktreeItem } from './nodes';

export class WorktreeTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private worktrees: DiscoveredWorktree[] = [];
  private loading = false;
  private readonly disposables: vscode.Disposable[] = [];
  private folderWatchers: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  /** Cache compare results per worktree path */
  private readonly compareCache = new Map<string, CompareResult>();
  private readonly compareErrors = new Map<string, string>();

  constructor(private readonly output: vscode.OutputChannel) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rewatch();
        this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('worktreeCompare')) {
          this.rewatch();
          this.refresh();
        }
      }),
    );
    this.rewatch();
    void this.refresh();
  }

  refresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.compareCache.clear();
      this.compareErrors.clear();
      void this.load();
    }, 150);
  }

  private async load(): Promise<void> {
    this.loading = true;
    this._onDidChangeTreeData.fire();
    try {
      this.worktrees = await discoverWorktrees(this.output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Discovery failed: ${message}`);
      this.worktrees = [];
    } finally {
      this.loading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  private rewatch(): void {
    for (const w of this.folderWatchers) {
      w.dispose();
    }
    this.folderWatchers = [];

    for (const root of resolveWatchRoots()) {
      const pattern = new vscode.RelativePattern(root, '*');
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.folderWatchers.push(
          watcher,
          watcher.onDidCreate(() => this.refresh()),
          watcher.onDidDelete(() => this.refresh()),
          watcher.onDidChange(() => this.refresh()),
        );
        this.output.appendLine(`Watching ${root}`);
      } catch {
        this.output.appendLine(`Watch root not ready: ${root}`);
      }
    }
  }

  private defaultBaseRef(): string {
    return vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<string>('defaultBaseRef', 'main');
  }

  private async getCompare(worktreePath: string): Promise<CompareResult | undefined> {
    const cached = this.compareCache.get(worktreePath);
    if (cached) {
      return cached;
    }
    try {
      const baseRef = await resolveBaseRef(worktreePath, this.defaultBaseRef());
      const result = await compareWorkingTreeToBase(worktreePath, baseRef);
      this.compareCache.set(worktreePath, result);
      this.compareErrors.delete(worktreePath);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Compare failed for ${worktreePath}: ${message}`);
      this.compareErrors.set(worktreePath, message);
      return undefined;
    }
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return this.getRootChildren();
    }

    switch (element.kind) {
      case 'worktree':
        return this.getWorktreeChildren(element);
      case 'compareRoot':
        return this.getCompareRootChildren(element);
      case 'section':
        return this.getSectionChildren(element);
      case 'commit':
        return this.getCommitChildren(element);
      default:
        return [];
    }
  }

  private getRootChildren(): TreeNode[] {
    if (this.loading && this.worktrees.length === 0) {
      return [new MessageItem('Scanning worktrees…', undefined, 'loading~spin')];
    }

    if (this.worktrees.length === 0) {
      const folders =
        vscode.workspace
          .getConfiguration('worktreeCompare')
          .get<string[]>('watchFolders', ['.claude/worktrees'])
          .join(', ') || '.claude/worktrees';
      return [new MessageItem('No worktrees found', `Watched: ${folders}`)];
    }

    return this.worktrees.map((wt) => new WorktreeItem(wt));
  }

  private async getWorktreeChildren(item: WorktreeItem): Promise<TreeNode[]> {
    const compare = await this.getCompare(item.worktreePath);
    if (!compare) {
      const err = this.compareErrors.get(item.worktreePath) ?? 'Compare failed';
      return [new MessageItem('Could not compare', err, 'error')];
    }
    return [
      new CompareRootItem(
        item.worktreePath,
        compare.baseRef,
        compare.ahead,
        compare.behind,
      ),
    ];
  }

  private async getCompareRootChildren(item: CompareRootItem): Promise<TreeNode[]> {
    const compare = await this.getCompare(item.worktreePath);
    if (!compare) {
      return [new MessageItem('Could not compare', undefined, 'error')];
    }

    const nodes: TreeNode[] = [];

    nodes.push(
      new SectionItem(
        `Behind ${compare.behind} commit${compare.behind === 1 ? '' : 's'}`,
        'behind',
        item.worktreePath,
        compare.baseRef,
        compare.behind > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      ),
    );

    nodes.push(
      new SectionItem(
        `Ahead ${compare.ahead} commit${compare.ahead === 1 ? '' : 's'}`,
        'ahead',
        item.worktreePath,
        compare.baseRef,
        compare.ahead > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      ),
    );

    const fileLabel = `${compare.files.length} file${compare.files.length === 1 ? '' : 's'} changed`;
    nodes.push(
      new SectionItem(
        fileLabel,
        'files',
        item.worktreePath,
        compare.baseRef,
        compare.files.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      ),
    );

    return nodes;
  }

  private async getSectionChildren(item: SectionItem): Promise<TreeNode[]> {
    const compare = await this.getCompare(item.worktreePath);
    if (!compare) {
      return [];
    }

    if (item.section === 'behind') {
      return compare.commitsBehind.map(
        (c) => new CommitItem(item.worktreePath, item.baseRef, c),
      );
    }

    if (item.section === 'ahead') {
      return compare.commitsAhead.map(
        (c) => new CommitItem(item.worktreePath, item.baseRef, c),
      );
    }

    // Working tree file list
    return compare.files.map(
      (f) => new FileItem(item.worktreePath, item.baseRef, f),
    );
  }

  private async getCommitChildren(item: CommitItem): Promise<TreeNode[]> {
    try {
      const files = await listCommitFiles(item.worktreePath, item.commit.hash);
      return files.map(
        (f) =>
          new FileItem(item.worktreePath, item.baseRef, f, item.commit.hash),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Commit files failed: ${message}`);
      return [new MessageItem('Could not list files', message, 'error')];
    }
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    for (const w of this.folderWatchers) {
      w.dispose();
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
