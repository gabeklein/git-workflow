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
import type { FileChange } from '../git/compare';
import { childrenAtPrefix, countFilesUnder, joinPrefix } from './fileTree';
import {
  BehindWarningItem,
  CommitItem,
  FileItem,
  FolderItem,
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
 *   ▼ Ahead / file sections for the selected worktree
 *
 * Hot-follow (safe): poll selected worktree only + VS Code file events
 * under that path. No recursive glob FileSystemWatchers.
 */
export class WorktreeTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onDidChangeWorktrees = new vscode.EventEmitter<void>();
  /** Fired when discovery list or selection changes. */
  readonly onDidChangeWorktrees = this._onDidChangeWorktrees.event;

  private worktrees: DiscoveredWorktree[] = [];
  private loading = false;
  private readonly disposables: vscode.Disposable[] = [];
  private folderWatchers: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private contentDebounce: NodeJS.Timeout | undefined;
  private softRefreshInFlight = false;
  /** 'active' = recent changes (faster poll); 'idle' = quiet (slower). */
  private pollPace: 'active' | 'idle' = 'idle';
  private lastFingerprintChangeAt = 0;

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
          this.restartPoll();
          if (
            e.affectsConfiguration('worktreeCompare.watchFolders') ||
            e.affectsConfiguration('worktreeCompare.includeRootCheckout')
          ) {
            this.refresh();
          } else if (
            e.affectsConfiguration('worktreeCompare.squashLayout') ||
            e.affectsConfiguration('worktreeCompare.defaultBaseRef')
          ) {
            const sel = this.getSelectedPath();
            if (sel) {
              this.refreshCompare(sel);
            }
          }
        }
      }),
      // Agent/editor writes through VS Code (no recursive FS watcher)
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.scheduleSoftRefreshIfUnderSelected(doc.uri);
      }),
      vscode.workspace.onDidCreateFiles((e) => {
        for (const u of e.files) {
          this.scheduleSoftRefreshIfUnderSelected(u);
        }
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const u of e.files) {
          this.scheduleSoftRefreshIfUnderSelected(u);
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          this.scheduleSoftRefreshIfUnderSelected(f.newUri);
          this.scheduleSoftRefreshIfUnderSelected(f.oldUri);
        }
      }),
    );
    this.rewatchFolders();
    this.restartPoll();
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

  /** Force re-fetch for one worktree (stage/unstage, layout toggle). */
  refreshCompare(worktreePath: string): void {
    this.snapshotCache.delete(worktreePath);
    this.compareErrors.delete(worktreePath);
    this._onDidChangeTreeData.fire();
  }

  /**
   * Hot-follow: re-run git status/diff for the focused worktree and only
   * rebuild the tree if something actually changed.
   */
  private scheduleSoftRefreshIfUnderSelected(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') {
      return;
    }
    const selected = this.getSelectedPath();
    if (!selected || !isPathInside(uri.fsPath, selected)) {
      return;
    }
    // File activity → bump to active pace (next scheduled poll uses it too)
    this.enterActivePollPace('file-event');
    if (this.contentDebounce) {
      clearTimeout(this.contentDebounce);
    }
    this.contentDebounce = setTimeout(() => {
      this.contentDebounce = undefined;
      void this.softRefreshSelected('file-event');
    }, 400);
  }

  /** Idle (relaxed) poll interval; 0 disables polling entirely. */
  private idlePollIntervalMs(): number {
    return vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<number>('contentRefreshIntervalMs', 5000);
  }

  /** Active (rapid) poll while changes keep landing. */
  private activePollIntervalMs(): number {
    const configured = vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<number>('contentRefreshActiveIntervalMs', 1500);
    const idle = this.idlePollIntervalMs();
    if (idle <= 0) {
      return configured;
    }
    // Never slower than idle; never below 500ms
    return Math.max(500, Math.min(configured, idle));
  }

  /** Quiet time before stepping back from active → idle pace. */
  private idleAfterMs(): number {
    return vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<number>('contentRefreshIdleAfterMs', 15000);
  }

  private enterActivePollPace(reason: string): void {
    const was = this.pollPace;
    this.pollPace = 'active';
    this.lastFingerprintChangeAt = Date.now();
    if (was !== 'active') {
      this.output.appendLine(`Hot-follow pace → active (${reason})`);
      // Reschedule sooner if we were idling on a long timer
      this.restartPoll();
    }
  }

  private maybeRelaxPollPace(): void {
    if (this.pollPace !== 'active') {
      return;
    }
    if (Date.now() - this.lastFingerprintChangeAt < this.idleAfterMs()) {
      return;
    }
    this.pollPace = 'idle';
    this.output.appendLine('Hot-follow pace → idle (quiet)');
  }

  private currentPollIntervalMs(): number {
    return this.pollPace === 'active'
      ? this.activePollIntervalMs()
      : this.idlePollIntervalMs();
  }

  private restartPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    const idle = this.idlePollIntervalMs();
    if (idle <= 0) {
      this.output.appendLine('Hot-follow poll disabled (contentRefreshIntervalMs=0)');
      return;
    }
    this.output.appendLine(
      `Hot-follow poll: idle=${idle}ms active=${this.activePollIntervalMs()}ms relaxAfter=${this.idleAfterMs()}ms`,
    );
    this.scheduleNextPoll();
  }

  private scheduleNextPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    const idle = this.idlePollIntervalMs();
    if (idle <= 0) {
      return;
    }
    this.maybeRelaxPollPace();
    const ms = this.currentPollIntervalMs();
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.runPollTick();
    }, ms);
  }

  private async runPollTick(): Promise<void> {
    try {
      if (vscode.window.state.focused) {
        await this.softRefreshSelected('poll');
      } else {
        // Unfocused: still decay toward idle so we don't stay hot forever
        this.maybeRelaxPollPace();
      }
    } finally {
      this.scheduleNextPoll();
    }
  }

  private async softRefreshSelected(reason: string): Promise<void> {
    const worktreePath = this.getSelectedPath();
    if (!worktreePath || this.loading || this.softRefreshInFlight) {
      return;
    }
    this.softRefreshInFlight = true;
    try {
      const prev = this.snapshotCache.get(worktreePath);
      const prevFp = prev ? snapshotFingerprint(prev) : undefined;
      this.snapshotCache.delete(worktreePath);
      const next = await this.getSnapshot(worktreePath);
      if (!next) {
        this._onDidChangeTreeData.fire();
        return;
      }
      const nextFp = snapshotFingerprint(next);
      if (prevFp === nextFp) {
        this.maybeRelaxPollPace();
        return;
      }
      this.enterActivePollPace(reason);
      this.output.appendLine(
        `Hot-follow update (${reason}, pace=${this.pollPace}): ${path.basename(worktreePath)}`,
      );
      this._onDidChangeTreeData.fire();
    } finally {
      this.softRefreshInFlight = false;
    }
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
        return await this.getRootChildren();
      }
      switch (element.kind) {
        case 'group':
          if (element.group === 'worktrees') {
            return this.getWorktreeListChildren();
          }
          return await this.getAheadChildren();
        case 'section':
          return await this.getSectionChildren(element);
        case 'folder':
          return await this.getFolderChildren(element);
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

  private async getRootChildren(): Promise<TreeNode[]> {
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
    const nodes: TreeNode[] = [
      new GroupItem(
        'Worktrees',
        'worktrees',
        vscode.TreeItemCollapsibleState.Expanded,
        String(this.worktrees.length),
      ),
    ];

    if (!selected) {
      nodes.push(new MessageItem('Select a worktree above'));
      return nodes;
    }

    const snap = await this.getSnapshot(selected.path);
    if (!snap) {
      const err = this.compareErrors.get(selected.path) ?? 'Failed to load';
      nodes.push(new MessageItem('Could not load worktree', err, 'error'));
      return nodes;
    }

    const { compare, status } = snap;
    const worktreePath = selected.path;

    // Soft warning above Ahead — only when behind > 0
    if (compare.behind > 0) {
      nodes.push(
        new BehindWarningItem(worktreePath, compare.baseRef, compare.behind),
      );
    }

    const aheadCount = compare.ahead;
    nodes.push(
      new GroupItem(
        'Ahead',
        'ahead',
        vscode.TreeItemCollapsibleState.Expanded,
        `${aheadCount} commit${aheadCount === 1 ? '' : 's'}`,
      ),
    );

    // File sections (siblings of Worktrees / Ahead)
    if (status.staged.length > 0) {
      nodes.push(
        new SectionItem(
          'Staged',
          'staged',
          worktreePath,
          compare.baseRef,
          vscode.TreeItemCollapsibleState.Expanded,
          String(status.staged.length),
        ),
      );
    }

    nodes.push(
      new SectionItem(
        'Changes',
        'changes',
        worktreePath,
        compare.baseRef,
        vscode.TreeItemCollapsibleState.Expanded,
        status.unstaged.length > 0 ? String(status.unstaged.length) : undefined,
      ),
    );

    nodes.push(
      new SectionItem(
        'Squashed',
        'squash',
        worktreePath,
        compare.baseRef,
        vscode.TreeItemCollapsibleState.Collapsed,
        compare.fullPrFiles.length > 0
          ? `${compare.fullPrFiles.length} vs ${compare.baseRef}`
          : `0 vs ${compare.baseRef}`,
      ),
    );

    return nodes;
  }

  private getWorktreeListChildren(): TreeNode[] {
    const selected = this.getSelectedPath();
    return this.worktrees.map(
      (wt) => new WorktreeListItem(wt, wt.path === selected),
    );
  }

  /** Commits ahead of base only (Behind lives above this group at root). */
  private async getAheadChildren(): Promise<TreeNode[]> {
    const selected = this.getSelected();
    if (!selected) {
      return [new MessageItem('Select a worktree above')];
    }
    const snap = await this.getSnapshot(selected.path);
    if (!snap) {
      const err = this.compareErrors.get(selected.path) ?? 'Failed to load';
      return [new MessageItem('Could not load', err, 'error')];
    }

    const { compare } = snap;
    if (compare.commitsAhead.length === 0) {
      return [new MessageItem('No commits ahead of base', compare.baseRef)];
    }

    return compare.commitsAhead.map(
      (c) => new CommitItem(selected.path, compare.baseRef, c),
    );
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

    // Squashed
    if (snap.compare.fullPrFiles.length === 0) {
      return [new MessageItem('No differences from base', item.baseRef)];
    }
    if (this.squashLayout() === 'tree') {
      return this.buildFolderLevel(
        item.worktreePath,
        item.baseRef,
        snap.compare.fullPrFiles,
        '',
      );
    }
    return snap.compare.fullPrFiles.map(
      (f) =>
        new FileItem(item.worktreePath, item.baseRef, f, {
          diffKind: 'vsBase',
        }),
    );
  }

  private async getFolderChildren(item: FolderItem): Promise<TreeNode[]> {
    const snap = await this.getSnapshot(item.worktreePath);
    if (!snap) {
      return [];
    }
    return this.buildFolderLevel(
      item.worktreePath,
      item.baseRef,
      snap.compare.fullPrFiles,
      item.folderPath,
    );
  }

  private squashLayout(): 'list' | 'tree' {
    const v = vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<string>('squashLayout', 'list');
    return v === 'tree' ? 'tree' : 'list';
  }

  private buildFolderLevel(
    worktreePath: string,
    baseRef: string,
    files: FileChange[],
    prefix: string,
  ): TreeNode[] {
    const level = childrenAtPrefix(files, prefix);
    const nodes: TreeNode[] = [];
    for (const dir of level.dirs) {
      const folderPath = joinPrefix(prefix, dir);
      nodes.push(
        new FolderItem(
          worktreePath,
          baseRef,
          folderPath,
          countFilesUnder(files, folderPath),
        ),
      );
    }
    for (const f of level.files) {
      nodes.push(
        new FileItem(worktreePath, baseRef, f, {
          diffKind: 'vsBase',
          treeLayout: true,
        }),
      );
    }
    return nodes;
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
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    if (this.contentDebounce) {
      clearTimeout(this.contentDebounce);
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

function isPathInside(fsPath: string, root: string): boolean {
  const resolved = path.resolve(fsPath);
  const rootResolved = path.resolve(root);
  return (
    resolved === rootResolved ||
    resolved.startsWith(rootResolved + path.sep)
  );
}

/** Cheap equality for deciding whether the tree UI needs a rebuild. */
function snapshotFingerprint(snap: WorktreeSnapshot): string {
  const { compare, status } = snap;
  const fmt = (files: FileChange[]) =>
    files
      .map((f) => `${f.status}:${f.path}${f.oldPath ? `>${f.oldPath}` : ''}`)
      .sort()
      .join('|');
  return [
    compare.baseRef,
    compare.ahead,
    compare.behind,
    compare.commitsAhead.map((c) => c.hash).join(','),
    fmt(status.staged),
    fmt(status.unstaged),
    fmt(compare.fullPrFiles),
  ].join('::');
}
