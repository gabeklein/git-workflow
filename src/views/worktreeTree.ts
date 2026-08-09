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
  MessageItem,
  SectionItem,
  type TreeNode,
  WorktreeItem,
} from './nodes';

export type { TreeNode } from './nodes';
export { FileItem, WorktreeItem } from './nodes';

interface WorktreeSnapshot {
  compare: CompareResult;
  status: WorkingStatus;
}

/**
 * Minimal, stable tree provider.
 * No recursive content watchers / polling (those OOM'd the extension host
 * on large monorepo worktrees after ~15–20s). Refresh is manual or when a
 * worktree directory is created/removed under the watch folder.
 */
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

  private readonly snapshotCache = new Map<string, WorktreeSnapshot>();
  private readonly compareErrors = new Map<string, string>();
  private readonly baseOverrides = new Map<string, string>();

  constructor(private readonly output: vscode.OutputChannel) {
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

  /** Re-fetch compare/status for one worktree (e.g. after stage). */
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

  private rewatchFolders(): void {
    for (const w of this.folderWatchers) {
      w.dispose();
    }
    this.folderWatchers = [];

    for (const root of resolveWatchRoots()) {
      // Only top-level create/delete of worktree dirs — not recursive **/*
      const pattern = new vscode.RelativePattern(root, '*');
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          pattern,
          false,
          true, // ignore change storms inside dirs
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
    try {
      const overridden = this.baseOverrides.get(worktreePath);
      const baseRef =
        overridden ??
        (await resolveBaseRef(worktreePath, this.defaultBaseRef()));
      if (!overridden) {
        this.output.appendLine(`Inferred base for ${worktreePath}: ${baseRef}`);
      }
      const [compare, status] = await Promise.all([
        compareWorkingTreeToBase(worktreePath, baseRef),
        getWorkingStatus(worktreePath),
      ]);
      const snap: WorktreeSnapshot = { compare, status };
      this.snapshotCache.set(worktreePath, snap);
      this.compareErrors.delete(worktreePath);
      return snap;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Snapshot failed for ${worktreePath}: ${message}`);
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
        case 'worktree':
          return await this.getWorktreeChildren(element);
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
    return this.worktrees.map((wt) => new WorktreeItem(wt));
  }

  private async getWorktreeChildren(item: WorktreeItem): Promise<TreeNode[]> {
    const snap = await this.getSnapshot(item.worktreePath);
    if (!snap) {
      const err = this.compareErrors.get(item.worktreePath) ?? 'Failed to load';
      return [new MessageItem('Could not load worktree', err, 'error')];
    }

    const { compare, status } = snap;
    const nodes: TreeNode[] = [];

    if (compare.behind > 0) {
      nodes.push(
        new BehindWarningItem(
          item.worktreePath,
          compare.baseRef,
          compare.behind,
        ),
      );
    }

    for (const c of compare.commitsAhead) {
      nodes.push(new CommitItem(item.worktreePath, compare.baseRef, c));
    }

    if (status.staged.length > 0) {
      nodes.push(
        new SectionItem(
          'Staged Changes',
          'staged',
          item.worktreePath,
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
        item.worktreePath,
        compare.baseRef,
        vscode.TreeItemCollapsibleState.Expanded,
        changesCount > 0 ? String(changesCount) : undefined,
      ),
    );

    const prCount = compare.fullPrFiles.length;
    nodes.push(
      new SectionItem(
        'Full PR',
        'fullPr',
        item.worktreePath,
        compare.baseRef,
        vscode.TreeItemCollapsibleState.Collapsed,
        prCount > 0
          ? `${prCount} vs ${compare.baseRef}`
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
  }
}
