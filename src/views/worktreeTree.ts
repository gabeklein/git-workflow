import * as path from 'node:path';
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
import { getWorkingStatus, type WorkingStatus } from '../git/status';
import { preferRemoteTrackingRef, resolveBaseRef } from '../git/worktree';
import {
  BehindWarningItem,
  CommitItem,
  FileItem,
  GroupItem,
  MessageItem,
  SectionItem,
  type TreeNode,
  WorktreeListItem,
} from './nodes';

export type { TreeNode } from './nodes';
export { CommitItem, FileItem, WorktreeListItem } from './nodes';

const SELECTED_PATH_KEY = 'worktreeCompare.selectedPath';

interface WorktreeSnapshot {
  compare: CompareResult;
  status: WorkingStatus;
}

/**
 * Single TreeView:
 *   ▼ Worktrees   — list (click to focus)
 *   ▼ Details     — body of the selected worktree
 */
export class WorktreeTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onDidChangeWorktrees = new vscode.EventEmitter<void>();
  /** Fired when discovery list or selection changes (for the select webview). */
  readonly onDidChangeWorktrees = this._onDidChangeWorktrees.event;

  private worktrees: DiscoveredWorktree[] = [];
  private loading = false;
  private readonly disposables: vscode.Disposable[] = [];
  private folderWatchers: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  private readonly snapshotCache = new Map<string, WorktreeSnapshot>();
  private readonly compareErrors = new Map<string, string>();
  private readonly baseOverrides = new Map<string, string>();

  private selectedPath: string | undefined;

  constructor(
    private readonly output: { appendLine(value: string): void },
    private readonly context: vscode.ExtensionContext,
  ) {
    this.selectedPath = context.workspaceState.get<string>(SELECTED_PATH_KEY);
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.rewatchFolders();
        this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('worktreeCompare')) {
          this.rewatchFolders();
          this.refresh();
        }
      }),
    );
    this.rewatchFolders();
    void this.refresh();
  }

  /** All discovered worktrees (for the picker). */
  getWorktrees(): DiscoveredWorktree[] {
    return this.worktrees.slice();
  }

  getSelectedPath(): string | undefined {
    return this.getSelected()?.path;
  }

  getSelected(): DiscoveredWorktree | undefined {
    if (this.worktrees.length === 0) {
      return undefined;
    }
    if (this.selectedPath) {
      const hit = this.worktrees.find((w) => w.path === this.selectedPath);
      if (hit) {
        return hit;
      }
    }
    return this.worktrees[0];
  }

  async setSelectedPath(worktreePath: string): Promise<void> {
    this.selectedPath = worktreePath;
    await this.context.workspaceState.update(SELECTED_PATH_KEY, worktreePath);
    this.output.appendLine(`Selected worktree → ${worktreePath}`);
    // Drop other snapshots so we don't grow unbounded; keep selected warm on next expand
    for (const key of [...this.snapshotCache.keys()]) {
      if (key !== worktreePath) {
        this.snapshotCache.delete(key);
      }
    }
    this._onDidChangeTreeData.fire();
    this._onDidChangeWorktrees.fire();
  }

  refresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.snapshotCache.clear();
      this.compareErrors.clear();
      void this.load();
    }, 150);
  }

  refreshCompare(worktreePath: string): void {
    this.snapshotCache.delete(worktreePath);
    this.compareErrors.delete(worktreePath);
    this._onDidChangeTreeData.fire();
  }

  getBaseRef(worktreePath: string): string | undefined {
    return (
      this.baseOverrides.get(worktreePath) ??
      this.snapshotCache.get(worktreePath)?.compare.baseRef
    );
  }

  async setBaseRef(worktreePath: string, baseRef: string): Promise<void> {
    const preferred = await preferRemoteTrackingRef(worktreePath, baseRef);
    this.baseOverrides.set(worktreePath, preferred);
    this.snapshotCache.delete(worktreePath);
    this.compareErrors.delete(worktreePath);
    this.output.appendLine(`Base ref for ${worktreePath} → ${preferred}`);
    this._onDidChangeTreeData.fire();
  }

  private async load(): Promise<void> {
    const t0 = Date.now();
    this.loading = true;
    this._onDidChangeTreeData.fire();
    try {
      this.worktrees = await discoverWorktrees(this.output);
      this.ensureValidSelection();
      this.output.appendLine(
        `Load done: ${this.worktrees.length} worktree(s), selected=${this.selectedPath ?? '(none)'} (${Date.now() - t0}ms)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Discovery failed: ${message}`);
      this.worktrees = [];
    } finally {
      this.loading = false;
      this._onDidChangeTreeData.fire();
      this._onDidChangeWorktrees.fire();
    }
  }

  private ensureValidSelection(): void {
    if (this.worktrees.length === 0) {
      this.selectedPath = undefined;
      return;
    }
    if (
      !this.selectedPath ||
      !this.worktrees.some((w) => w.path === this.selectedPath)
    ) {
      this.selectedPath = this.worktrees[0]!.path;
      void this.context.workspaceState.update(
        SELECTED_PATH_KEY,
        this.selectedPath,
      );
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
        const watcher = vscode.workspace.createFileSystemWatcher(
          pattern,
          false,
          true,
          false,
        );
        this.folderWatchers.push(
          watcher,
          watcher.onDidCreate(() => this.refresh()),
          watcher.onDidDelete(() => this.refresh()),
        );
        this.output.appendLine(`Watching (create/delete only): ${root}`);
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

  private async getSnapshot(
    worktreePath: string,
  ): Promise<WorktreeSnapshot | undefined> {
    const cached = this.snapshotCache.get(worktreePath);
    if (cached) {
      return cached;
    }
    const t0 = Date.now();
    try {
      const overridden = this.baseOverrides.get(worktreePath);
      const tBase = Date.now();
      const baseRef =
        overridden ??
        (await resolveBaseRef(worktreePath, this.defaultBaseRef()));
      if (!overridden) {
        this.output.appendLine(
          `Inferred base for ${worktreePath}: ${baseRef} (${Date.now() - tBase}ms)`,
        );
      }
      const tDiff = Date.now();
      const [compare, status] = await Promise.all([
        compareWorkingTreeToBase(worktreePath, baseRef),
        getWorkingStatus(worktreePath),
      ]);
      this.output.appendLine(
        `Snapshot ${path.basename(worktreePath)}: base=${baseRef} ahead=${compare.ahead} staged=${status.staged.length} unstaged=${status.unstaged.length} (diff ${Date.now() - tDiff}ms, total ${Date.now() - t0}ms)`,
      );
      const snap: WorktreeSnapshot = { compare, status };
      this.snapshotCache.set(worktreePath, snap);
      this.compareErrors.delete(worktreePath);
      return snap;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(
        `Snapshot failed for ${worktreePath} after ${Date.now() - t0}ms: ${message}`,
      );
      this.compareErrors.set(worktreePath, message);
      return undefined;
    }
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    try {
      if (!element) {
        return this.getRootChildren();
      }
      switch (element.kind) {
        case 'group':
          if (element.group === 'worktrees') {
            return this.getWorktreeListChildren();
          }
          return await this.getDetailsChildren();
        case 'section':
          return await this.getSectionChildren(element);
        case 'commit':
          return await this.getCommitChildren(element);
        default:
          return [];
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`getChildren failed: ${message}`);
      return [new MessageItem('Error loading items', message, 'error')];
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

    const selected = this.getSelected();
    const detailsDesc = selected
      ? selected.branch + (selected.detached ? ' (detached)' : '')
      : undefined;

    return [
      new GroupItem(
        'Worktrees',
        'worktrees',
        vscode.TreeItemCollapsibleState.Expanded,
        String(this.worktrees.length),
      ),
      new GroupItem(
        'Details',
        'details',
        vscode.TreeItemCollapsibleState.Expanded,
        detailsDesc,
      ),
    ];
  }

  private getWorktreeListChildren(): TreeNode[] {
    const selected = this.getSelectedPath();
    return this.worktrees.map(
      (wt) => new WorktreeListItem(wt, wt.path === selected),
    );
  }

  private async getDetailsChildren(): Promise<TreeNode[]> {
    const selected = this.getSelected();
    if (!selected) {
      return [new MessageItem('Select a worktree above')];
    }
    return this.getWorktreeBody(selected.path);
  }

  private async getWorktreeBody(worktreePath: string): Promise<TreeNode[]> {
    const snap = await this.getSnapshot(worktreePath);
    if (!snap) {
      const err = this.compareErrors.get(worktreePath) ?? 'Failed to load';
      return [new MessageItem('Could not load worktree', err, 'error')];
    }

    const { compare, status } = snap;
    const nodes: TreeNode[] = [];

    if (compare.behind > 0) {
      nodes.push(
        new BehindWarningItem(worktreePath, compare.baseRef, compare.behind),
      );
    }

    for (const c of compare.commitsAhead) {
      nodes.push(new CommitItem(worktreePath, compare.baseRef, c));
    }

    if (status.staged.length > 0) {
      nodes.push(
        new SectionItem(
          'Staged Changes',
          'staged',
          worktreePath,
          compare.baseRef,
          vscode.TreeItemCollapsibleState.Expanded,
          String(status.staged.length),
        ),
      );
    }

    const changesCount = status.unstaged.length;
    nodes.push(
      new SectionItem(
        'Changes',
        'changes',
        worktreePath,
        compare.baseRef,
        vscode.TreeItemCollapsibleState.Expanded,
        changesCount > 0 ? String(changesCount) : undefined,
      ),
    );

    const squashCount = compare.fullPrFiles.length;
    nodes.push(
      new SectionItem(
        'Squashed',
        'squash',
        worktreePath,
        compare.baseRef,
        vscode.TreeItemCollapsibleState.Collapsed,
        squashCount > 0
          ? `${squashCount} vs ${compare.baseRef}`
          : `0 vs ${compare.baseRef}`,
      ),
    );

    return nodes;
  }

  private async getSectionChildren(item: SectionItem): Promise<TreeNode[]> {
    const snap = await this.getSnapshot(item.worktreePath);
    if (!snap) {
      return [];
    }

    if (item.section === 'staged') {
      return snap.status.staged.map(
        (f) =>
          new FileItem(item.worktreePath, item.baseRef, f, {
            diffKind: 'vsHead',
            statusSide: 'staged',
          }),
      );
    }

    if (item.section === 'changes') {
      if (snap.status.unstaged.length === 0) {
        return [new MessageItem('No unstaged changes')];
      }
      return snap.status.unstaged.map(
        (f) =>
          new FileItem(item.worktreePath, item.baseRef, f, {
            diffKind: 'vsHead',
            statusSide: 'unstaged',
          }),
      );
    }

    if (snap.compare.fullPrFiles.length === 0) {
      return [new MessageItem('No differences from base', item.baseRef)];
    }
    return snap.compare.fullPrFiles.map(
      (f) =>
        new FileItem(item.worktreePath, item.baseRef, f, {
          diffKind: 'vsBase',
        }),
    );
  }

  private async getCommitChildren(item: CommitItem): Promise<TreeNode[]> {
    try {
      const files = await listCommitFiles(item.worktreePath, item.commit.hash);
      return files.map(
        (f) =>
          new FileItem(item.worktreePath, item.baseRef, f, {
            diffKind: 'commit',
            commitHash: item.commit.hash,
          }),
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
    this._onDidChangeWorktrees.dispose();
  }
}
