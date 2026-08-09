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
import { preferRemoteTrackingRef, resolveBaseRef } from '../git/worktree';
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
export { CompareRootItem, FileItem, WorktreeItem } from './nodes';

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
  /** Per-worktree content watchers (agent writes inside an expanded tree) */
  private contentWatchers = new Map<string, vscode.Disposable[]>();
  private refreshTimer: NodeJS.Timeout | undefined;
  private contentDebounce = new Map<string, NodeJS.Timeout>();
  private pollTimer: NodeJS.Timeout | undefined;

  /** Cache compare results per worktree path */
  private readonly compareCache = new Map<string, CompareResult>();
  private readonly compareErrors = new Map<string, string>();
  /** User-picked base ref overrides (path → ref). Survives refresh. */
  private readonly baseOverrides = new Map<string, string>();
  /** Worktrees the user has expanded at least once this session */
  private readonly expandedPaths = new Set<string>();

  constructor(private readonly output: vscode.OutputChannel) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rewatchFolders();
        this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('worktreeCompare')) {
          this.rewatchFolders();
          this.restartPoll();
          this.refresh();
        }
      }),
    );
    this.rewatchFolders();
    this.restartPoll();
    void this.refresh();
  }

  refresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.compareCache.clear();
      this.compareErrors.clear();
      // baseOverrides intentionally kept
      void this.load();
    }, 150);
  }

  /**
   * Re-run compare for a single worktree without rediscovering the list.
   * Used when agent activity mutates files inside an expanded tree.
   */
  refreshCompare(worktreePath: string): void {
    this.compareCache.delete(worktreePath);
    this.compareErrors.delete(worktreePath);
    this._onDidChangeTreeData.fire();
  }

  /** Current base used for a worktree (override or resolved default). */
  getBaseRef(worktreePath: string): string | undefined {
    return (
      this.baseOverrides.get(worktreePath) ??
      this.compareCache.get(worktreePath)?.baseRef
    );
  }

  /**
   * Set the compare base for a worktree and refresh its compare tree.
   * Prefers origin/<name> when the user picks a bare local integration branch.
   */
  async setBaseRef(worktreePath: string, baseRef: string): Promise<void> {
    const preferred = await preferRemoteTrackingRef(worktreePath, baseRef);
    this.baseOverrides.set(worktreePath, preferred);
    this.compareCache.delete(worktreePath);
    this.compareErrors.delete(worktreePath);
    if (preferred !== baseRef) {
      this.output.appendLine(
        `Base ref for ${worktreePath} → ${preferred} (preferred remote for ${baseRef})`,
      );
    } else {
      this.output.appendLine(`Base ref for ${worktreePath} → ${preferred}`);
    }
    this._onDidChangeTreeData.fire();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this._onDidChangeTreeData.fire();
    try {
      this.worktrees = await discoverWorktrees(this.output);
      this.syncContentWatchers();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Discovery failed: ${message}`);
      this.worktrees = [];
    } finally {
      this.loading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  private rewatchFolders(): void {
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

  /**
   * Watch file content under worktrees the user has expanded.
   * Debounced → refreshCompare.
   */
  private syncContentWatchers(): void {
    const live = new Set(this.worktrees.map((w) => w.path));

    for (const [wtPath, disposables] of this.contentWatchers) {
      if (!live.has(wtPath) || !this.expandedPaths.has(wtPath)) {
        for (const d of disposables) {
          d.dispose();
        }
        this.contentWatchers.delete(wtPath);
      }
    }

    for (const wtPath of this.expandedPaths) {
      if (!live.has(wtPath) || this.contentWatchers.has(wtPath)) {
        continue;
      }
      try {
        const pattern = new vscode.RelativePattern(wtPath, '**/*');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        const bump = (uri?: vscode.Uri) => {
          if (uri && shouldIgnoreContentPath(uri.fsPath)) {
            return;
          }
          this.scheduleContentRefresh(wtPath);
        };
        this.contentWatchers.set(wtPath, [
          watcher,
          watcher.onDidCreate(bump),
          watcher.onDidChange(bump),
          watcher.onDidDelete(bump),
        ]);
        this.output.appendLine(`Content-watching ${wtPath}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`Content watch failed for ${wtPath}: ${message}`);
      }
    }
  }

  private scheduleContentRefresh(worktreePath: string): void {
    const existing = this.contentDebounce.get(worktreePath);
    if (existing) {
      clearTimeout(existing);
    }
    this.contentDebounce.set(
      worktreePath,
      setTimeout(() => {
        this.contentDebounce.delete(worktreePath);
        this.refreshCompare(worktreePath);
      }, 400),
    );
  }

  private contentRefreshIntervalMs(): number {
    return vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<number>('contentRefreshIntervalMs', 3000);
  }

  private restartPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    const ms = this.contentRefreshIntervalMs();
    if (ms <= 0) {
      return;
    }
    this.pollTimer = setInterval(() => {
      if (this.expandedPaths.size === 0) {
        return;
      }
      for (const wtPath of this.expandedPaths) {
        this.refreshCompare(wtPath);
      }
    }, ms);
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
      const overridden = this.baseOverrides.get(worktreePath);
      const baseRef =
        overridden ??
        (await resolveBaseRef(worktreePath, this.defaultBaseRef()));
      if (!overridden) {
        this.output.appendLine(`Inferred base for ${worktreePath}: ${baseRef}`);
      }
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
    if (!this.expandedPaths.has(item.worktreePath)) {
      this.expandedPaths.add(item.worktreePath);
      this.syncContentWatchers();
    }

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
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    for (const t of this.contentDebounce.values()) {
      clearTimeout(t);
    }
    this.contentDebounce.clear();
    for (const w of this.folderWatchers) {
      w.dispose();
    }
    for (const list of this.contentWatchers.values()) {
      for (const d of list) {
        d.dispose();
      }
    }
    this.contentWatchers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}

/** Skip high-churn / irrelevant paths so agent watches stay cheap. */
function shouldIgnoreContentPath(fsPath: string): boolean {
  const parts = fsPath.split(/[/\\]/);
  for (const part of parts) {
    if (
      part === '.git' ||
      part === 'node_modules' ||
      part === 'dist' ||
      part === 'out' ||
      part === '.next' ||
      part === 'coverage' ||
      part === '.turbo'
    ) {
      return true;
    }
  }
  return false;
}
