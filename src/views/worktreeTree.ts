import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  discoverWorktrees,
  isDirectChildOfWatchRoot,
  type DiscoveredWorktree,
} from '../discovery/scanner';
import {
  compareWorkingTreeToBase,
  formatFileChangeBreakdown,
  listCommitFiles,
  type CompareResult,
  type FileChange,
} from '../git/compare';
import {
  integrationBaseRef,
  isLaneBranch,
  type RebuildResult,
} from '../git/integration';
import { getWorkingStatus, type WorkingStatus } from '../git/status';
import {
  findPullRequestForBranch,
  isGithubPrIntegrationEnabled,
  prCacheKey,
  prHasMergeConflicts,
  resetGithubPrClient,
  type PullRequestInfo,
} from '../github/pr';
import { BaseStatusTracker } from './baseStatusTracker';
import { childrenAtPrefix, joinPrefix } from './fileTree';
import { GitActivityHub } from './gitActivityHub';
import {
  IntegrationController,
  type IntegrationState,
} from './integrationController';
import {
  ConflictWarningItem,
  CommitItem,
  FileItem,
  FolderItem,
  GroupItem,
  type IntegrationRowInfo,
  MessageItem,
  SectionItem,
  type TreeNode,
  WorktreeListItem,
} from './nodes';
import { isPathInside, shouldIgnoreHotFollowPath } from './pathFilters';
import { WorktreeSelectionDecorationProvider } from './worktreeDecorations';

export type { TreeNode } from './nodes';
export { CommitItem, FileItem, WorktreeListItem } from './nodes';

const SELECTED_PATH_KEY = 'worktreeCompare.selectedPath';

interface WorktreeSnapshot {
  compare: CompareResult;
  status: WorkingStatus;
}

/**
 * Composition root for the Worktree panel:
 *   discovery + selection + compare snapshots (hot-follow) + PR badges,
 * with the integration overlay (IntegrationController), base badges
 * (BaseStatusTracker), and .git change detection (GitActivityHub) as
 * dedicated modules. Also renders the Changes view via getChangesChildren.
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

  private readonly _onGitActivity = new vscode.EventEmitter<void>();
  /** Fired after each .git-event/poll state check — cheap change signal. */
  readonly onGitActivity = this._onGitActivity.event;

  private worktrees: DiscoveredWorktree[] = [];
  private loading = false;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private contentDebounce: NodeJS.Timeout | undefined;
  private softRefreshInFlight = false;
  /** 'active' = recent changes (faster poll); 'idle' = quiet (slower). */
  private pollPace: 'active' | 'idle' = 'idle';
  private lastFingerprintChangeAt = 0;

  private readonly snapshotCache = new Map<string, WorktreeSnapshot>();
  private readonly compareErrors = new Map<string, string>();
  /** PR lookup cache keyed by worktreePath\\0branch */
  private readonly prCache = new Map<string, PullRequestInfo | null>();
  private prRefreshGeneration = 0;

  private selectedPath: string | undefined;
  private readonly selectionDecorations =
    new WorktreeSelectionDecorationProvider();

  private readonly integration: IntegrationController;
  private readonly baseStatus: BaseStatusTracker;
  private readonly activity: GitActivityHub;

  constructor(
    private readonly output: { appendLine(value: string): void },
    private readonly context: vscode.ExtensionContext,
  ) {
    this.integration = new IntegrationController({
      output,
      getWorktrees: () => this.worktrees,
      getSelectedPath: () => this.selectedPath,
      fireTreeData: () => this._onDidChangeTreeData.fire(),
      refresh: () => this.refresh(),
      refreshCompare: (p) => this.refreshCompare(p),
      moveSelectionOff: (p) => this.moveSelectionOff(p),
    });
    this.baseStatus = new BaseStatusTracker({
      output,
      getWorktrees: () => this.worktrees,
      listedWorktrees: () => this.listedWorktrees(),
      fallbackBaseRef: () => this.compareFallbackBaseRef(),
      fireTreeData: () => this._onDidChangeTreeData.fire(),
    });
    this.activity = new GitActivityHub({
      output,
      onMembershipChanged: (reason) => {
        this.output.appendLine(`Worktree list changed (${reason}) — rediscover`);
        this.refresh();
      },
      onTick: async () => {
        await this.integration.tick();
        void this.baseStatus.refresh();
      },
      onActivity: () => this._onGitActivity.fire(),
    });

    this.selectedPath = context.workspaceState.get<string>(SELECTED_PATH_KEY);
    this.selectionDecorations.setSelectedPath(this.selectedPath);
    this.disposables.push(
      this.selectionDecorations,
      this.integration,
      this.activity,
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.activity.restart();
        this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('worktreeCompare')) {
          if (e.affectsConfiguration('worktreeCompare.watchFolders')) {
            this.activity.restartPoll();
          }
          this.restartPoll();
          if (e.affectsConfiguration('worktreeCompare.githubPullRequests')) {
            resetGithubPrClient();
            this.prCache.clear();
            void this.refreshPullRequests();
          }
          if (
            e.affectsConfiguration('worktreeCompare.watchFolders') ||
            e.affectsConfiguration('worktreeCompare.includeRootCheckout') ||
            e.affectsConfiguration('worktreeCompare.integrationBranch')
          ) {
            this.refresh();
          } else if (
            e.affectsConfiguration('worktreeCompare.integrationBaseRef')
          ) {
            void this.integration.handleBaseChange();
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
        if (process.env.GW_TEST_HOOKS === '1') {
          this.output.appendLine(
            `save event: ${doc.uri.scheme}:${doc.uri.fsPath}`,
          );
        }
        this.scheduleSoftRefreshIfUnderSelected(doc.uri);
        this.integration.scheduleWipRebuildIfUnderWipLane(doc.uri);
      }),
      vscode.workspace.onDidCreateFiles((e) => {
        for (const u of e.files) {
          this.scheduleDiscoverIfWatchRootChild(u);
          this.scheduleSoftRefreshIfUnderSelected(u);
          this.integration.scheduleWipRebuildIfUnderWipLane(u);
        }
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const u of e.files) {
          this.scheduleDiscoverIfWatchRootChild(u);
          this.scheduleSoftRefreshIfUnderSelected(u);
          this.integration.scheduleWipRebuildIfUnderWipLane(u);
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          this.scheduleDiscoverIfWatchRootChild(f.newUri);
          this.scheduleDiscoverIfWatchRootChild(f.oldUri);
          this.scheduleSoftRefreshIfUnderSelected(f.newUri);
          this.scheduleSoftRefreshIfUnderSelected(f.oldUri);
          this.integration.scheduleWipRebuildIfUnderWipLane(f.newUri);
          this.integration.scheduleWipRebuildIfUnderWipLane(f.oldUri);
        }
      }),
    );
    void this.activity.restart();
    this.restartPoll();
    void this.refresh();
  }

  // ---- worktrees & selection ---------------------------------------------

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

  getWorktree(worktreePath: string): DiscoveredWorktree | undefined {
    const key = path.normalize(worktreePath);
    return this.worktrees.find((w) => path.normalize(w.path) === key);
  }

  /** Repo cwd for gh / fetch (selected worktree, else first, else workspace). */
  getRepoCwd(): string | undefined {
    return (
      this.getSelectedPath() ??
      this.worktrees[0]?.path ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );
  }

  async setSelectedPath(worktreePath: string): Promise<void> {
    this.selectedPath = worktreePath;
    this.selectionDecorations.setSelectedPath(worktreePath);
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

  /** Selection landed on the integration checkout — move to a real lane. */
  private moveSelectionOff(worktreePath: string): void {
    const fallback = this.worktrees.find((w) => w.path !== worktreePath);
    this.selectedPath = fallback?.path;
    this.selectionDecorations.setSelectedPath(this.selectedPath);
    void this.context.workspaceState.update(
      SELECTED_PATH_KEY,
      this.selectedPath,
    );
    this.output.appendLine(
      `Selection moved off integration checkout → ${this.selectedPath ?? '(none)'}`,
    );
  }

  private ensureValidSelection(): void {
    if (this.worktrees.length === 0) {
      this.selectedPath = undefined;
      this.selectionDecorations.setSelectedPath(undefined);
      return;
    }
    if (
      !this.selectedPath ||
      !this.worktrees.some((w) => w.path === this.selectedPath)
    ) {
      // Prefer a real worktree; the integration checkout only via clicks
      const first =
        this.worktrees.find((w) => w.path !== this.integration.getPath()) ??
        this.worktrees[0]!;
      this.selectedPath = first.path;
      void this.context.workspaceState.update(
        SELECTED_PATH_KEY,
        this.selectedPath,
      );
    }
    this.selectionDecorations.setSelectedPath(this.selectedPath);
  }

  // ---- discovery ----------------------------------------------------------

  refresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.snapshotCache.clear();
      this.compareErrors.clear();
      this.baseStatus.invalidateAll();
      // Keep PR cache across list refresh; explicit refreshPullRequests clears it
      void this.load();
    }, 150);
  }

  /** Force re-fetch for one worktree (stage/unstage, layout toggle). */
  refreshCompare(worktreePath: string): void {
    this.snapshotCache.delete(worktreePath);
    this.compareErrors.delete(worktreePath);
    this._onDidChangeTreeData.fire();
  }

  private async load(): Promise<void> {
    const t0 = Date.now();
    this.loading = true;
    this._onDidChangeTreeData.fire();
    try {
      this.worktrees = await discoverWorktrees(this.output);
      this.ensureValidSelection();
      this.prunePrCache();
      await this.integration.refreshState();
      void this.baseStatus.refresh();
      this.output.appendLine(
        `Load done: ${this.worktrees.length} worktree(s), selected=${this.selectedPath ?? '(none)'} (${Date.now() - t0}ms)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Discovery failed: ${message}`);
      this.worktrees = [];
      this.prCache.clear();
    } finally {
      this.loading = false;
      this._onDidChangeTreeData.fire();
      this._onDidChangeWorktrees.fire();
      // Background: associate open PRs with worktree branches
      void this.refreshPullRequests();
    }
  }

  /**
   * New/removed linked worktrees: VS Code file events when the editor did
   * the create/delete, plus the hub's poll for changes outside VS Code.
   */
  private scheduleDiscoverIfWatchRootChild(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') {
      return;
    }
    if (!isDirectChildOfWatchRoot(uri.fsPath)) {
      return;
    }
    this.refresh();
  }

  // ---- PR badges -----------------------------------------------------------

  /** Cached PR for a worktree row (if looked up). */
  getPullRequest(worktreePath: string): PullRequestInfo | undefined {
    const wt = this.worktrees.find((w) => w.path === worktreePath);
    if (!wt) {
      return undefined;
    }
    const key = prCacheKey(wt.path, wt.branch);
    const hit = this.prCache.get(key);
    return hit ?? undefined;
  }

  /** Drop PR cache so the next lookup re-queries `gh`. */
  clearPullRequestCache(): void {
    this.prCache.clear();
  }

  /** Re-query GitHub (via `gh`) for PRs associated with each worktree branch. */
  async refreshPullRequests(): Promise<void> {
    if (!isGithubPrIntegrationEnabled()) {
      if (this.prCache.size > 0) {
        this.prCache.clear();
        this._onDidChangeTreeData.fire();
      }
      return;
    }
    if (this.worktrees.length === 0) {
      return;
    }
    const generation = ++this.prRefreshGeneration;
    const t0 = Date.now();
    let found = 0;
    try {
      // Bounded concurrency so many worktrees don't spawn a gh storm
      const queue = this.worktrees.slice();
      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length > 0) {
          if (generation !== this.prRefreshGeneration) {
            return;
          }
          const wt = queue.shift();
          if (!wt) {
            return;
          }
          const key = prCacheKey(wt.path, wt.branch);
          try {
            const pr = await findPullRequestForBranch(
              wt.path,
              wt.branch,
              wt.detached,
            );
            if (generation !== this.prRefreshGeneration) {
              return;
            }
            this.prCache.set(key, pr ?? null);
            if (pr) {
              found += 1;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.output.appendLine(
              `PR lookup failed for ${wt.branch}: ${message}`,
            );
            this.prCache.set(key, null);
          }
        }
      });
      await Promise.all(workers);
      if (generation !== this.prRefreshGeneration) {
        return;
      }
      this.output.appendLine(
        `GitHub PR lookup: ${found}/${this.worktrees.length} branch(es) have a PR (${Date.now() - t0}ms)`,
      );
      this._onDidChangeTreeData.fire();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`GitHub PR lookup failed: ${message}`);
    }
  }

  /** Drop PR cache entries for worktrees / branches that no longer exist. */
  private prunePrCache(): void {
    if (this.prCache.size === 0) {
      return;
    }
    const live = new Set(
      this.worktrees.map((wt) => prCacheKey(wt.path, wt.branch)),
    );
    for (const key of [...this.prCache.keys()]) {
      if (!live.has(key)) {
        this.prCache.delete(key);
      }
    }
  }

  // ---- hot-follow compare (selected worktree) ------------------------------

  private scheduleSoftRefreshIfUnderSelected(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') {
      return;
    }
    const selected = this.getSelected();
    if (!selected || !isPathInside(uri.fsPath, selected.path)) {
      return;
    }
    // Root monorepo checkout: ignore high-churn / irrelevant paths so every
    // node_modules or dist write does not trigger git status.
    if (shouldIgnoreHotFollowPath(uri.fsPath, selected.path)) {
      return;
    }
    // File activity → mark active (poll pace, if enabled)
    this.enterActivePollPace('file-event');
    if (this.contentDebounce) {
      clearTimeout(this.contentDebounce);
    }
    // Longer debounce: agent bursts can write many files in one go
    this.contentDebounce = setTimeout(() => {
      this.contentDebounce = undefined;
      void this.softRefreshSelected('file-event');
    }, 800);
  }

  /** Idle (relaxed) poll interval; 0 disables polling entirely. */
  private idlePollIntervalMs(): number {
    return vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<number>('contentRefreshIntervalMs', 0);
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
      // Pull the next poll forward without a full restart/log spam
      this.scheduleNextPoll();
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
      this.output.appendLine(
        'Hot-follow poll disabled (contentRefreshIntervalMs=0); save/create/delete events still refresh',
      );
      return;
    }
    this.pollPace = 'idle';
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
        this.maybeRelaxPollPace();
      }
    } finally {
      this.scheduleNextPoll();
    }
  }

  /**
   * Cheap content refresh: reuse cached baseRef; only re-run status/diff.
   * Avoids resolveBaseRef on every tick (that path was hang-prone).
   */
  private async softRefreshSelected(reason: string): Promise<void> {
    const worktreePath = this.getSelectedPath();
    if (!worktreePath || this.loading || this.softRefreshInFlight) {
      return;
    }
    this.softRefreshInFlight = true;
    try {
      const prev = this.snapshotCache.get(worktreePath);
      const prevFp = prev ? snapshotFingerprint(prev) : undefined;
      const baseRef =
        prev?.compare.baseRef ?? (await this.worktreeBaseFor(worktreePath));

      const [compare, status] = await Promise.all([
        compareWorkingTreeToBase(worktreePath, baseRef),
        getWorkingStatus(worktreePath),
      ]);
      const next: WorktreeSnapshot = { compare, status };
      const nextFp = snapshotFingerprint(next);
      this.snapshotCache.set(worktreePath, next);
      this.compareErrors.delete(worktreePath);

      if (prevFp === nextFp) {
        this.maybeRelaxPollPace();
        return;
      }
      this.enterActivePollPace(reason);
      this.output.appendLine(
        `Hot-follow update (${reason}, pace=${this.pollPace}): ${path.basename(worktreePath)}`,
      );
      this._onDidChangeTreeData.fire();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Hot-follow soft refresh failed: ${message}`);
    } finally {
      this.softRefreshInFlight = false;
    }
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
      const overridden = this.baseStatus.getOverride(worktreePath);
      const tBase = Date.now();
      const baseRef = await this.worktreeBaseFor(worktreePath);
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

  // ---- bases & badges (delegates) ------------------------------------------

  getBaseRef(worktreePath: string): string | undefined {
    return (
      this.baseStatus.getOverride(worktreePath) ??
      this.snapshotCache.get(worktreePath)?.compare.baseRef
    );
  }

  async setBaseRef(worktreePath: string, baseRef: string): Promise<void> {
    const preferred = await this.baseStatus.setOverride(worktreePath, baseRef);
    this.snapshotCache.delete(worktreePath);
    this.compareErrors.delete(worktreePath);
    this.output.appendLine(`Base ref for ${worktreePath} → ${preferred}`);
    this._onDidChangeTreeData.fire();
  }

  worktreeBaseFor(worktreePath: string): Promise<string> {
    return this.baseStatus.baseFor(worktreePath);
  }

  getBaseStatus(worktreePath: string) {
    return this.baseStatus.status(worktreePath);
  }

  refreshBaseStatuses(): Promise<void> {
    return this.baseStatus.refresh();
  }

  private defaultBaseRef(): string {
    return vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<string>('defaultBaseRef', 'main');
  }

  /**
   * Fallback for compare-base inference. While integration is active,
   * lanes land on the integration base, so it is the sane default —
   * per-worktree inference (reflog/upstream) and overrides still win.
   */
  private compareFallbackBaseRef(): string {
    return this.integration.getPath()
      ? integrationBaseRef()
      : this.defaultBaseRef();
  }

  // ---- integration (delegates) ---------------------------------------------

  getIntegration(): IntegrationState | undefined {
    return this.integration.getState();
  }

  runIntegrationRebuild(reason: string): Promise<RebuildResult> {
    return this.integration.runRebuild(reason);
  }

  addIntegrationCandidate(branch: string): Promise<void> {
    return this.integration.addCandidate(branch);
  }

  removeIntegrationCandidate(branch: string): Promise<RebuildResult> {
    return this.integration.removeCandidate(branch);
  }

  applyToIntegration(branch: string): Promise<RebuildResult> {
    return this.integration.apply(branch);
  }

  hideFromIntegration(branch: string): Promise<RebuildResult> {
    return this.integration.hide(branch);
  }

  setLaneWip(branch: string, enabled: boolean): Promise<RebuildResult> {
    return this.integration.setLaneWip(branch, enabled);
  }

  abortIntegrationMerge(): Promise<void> {
    return this.integration.abortMerge();
  }

  // ---- rendering ------------------------------------------------------------

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) {
      return []; // worktree rows are leaves; details live in the Changes view
    }
    if (this.loading && this.worktrees.length === 0) {
      return [new MessageItem('Scanning worktrees…', undefined, 'loading~spin')];
    }
    if (this.worktrees.length === 0) {
      return [
        new MessageItem(
          'No worktrees found',
          'No worktrees registered with this repo (git worktree list)',
        ),
      ];
    }
    return this.getWorktreeListChildren();
  }

  /**
   * Children for the Changes view (rendered by ChangesTreeProvider):
   * Commits / Staged / Unstaged / Full Diff for the selected worktree.
   */
  async getChangesChildren(element?: TreeNode): Promise<TreeNode[]> {
    try {
      if (!element) {
        return await this.getChangesRootChildren();
      }
      switch (element.kind) {
        case 'group':
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

  private async getChangesRootChildren(): Promise<TreeNode[]> {
    const nodes: TreeNode[] = [];

    if (this.loading && this.worktrees.length === 0) {
      nodes.push(new MessageItem('Scanning worktrees…', undefined, 'loading~spin'));
    } else if (this.worktrees.length === 0) {
      nodes.push(new MessageItem('No worktrees found'));
    } else {
      const selected = this.getSelected();
      if (!selected) {
        nodes.push(new MessageItem('Select a worktree in the panel above'));
      } else {
        const snap = await this.getSnapshot(selected.path);
        if (!snap) {
          const err = this.compareErrors.get(selected.path) ?? 'Failed to load';
          nodes.push(new MessageItem('Could not load worktree', err, 'error'));
        } else {
          const { compare, status } = snap;
          const worktreePath = selected.path;

          const selectedPr = this.getPullRequest(worktreePath);
          if (selectedPr && prHasMergeConflicts(selectedPr)) {
            nodes.push(
              new ConflictWarningItem(worktreePath, selectedPr, compare.baseRef),
            );
          }

          // "Commits · N → branch (@ SHA)" — @ sha only when pinned off tip
          const aheadCount = compare.ahead;
          const aheadTarget = compare.compareIsTip
            ? `→ ${compare.baseRef}`
            : `→ ${compare.baseRef} @ ${compare.baseHead}`;
          nodes.push(
            new GroupItem(
              `Commits · ${aheadCount}`,
              'ahead',
              vscode.TreeItemCollapsibleState.Collapsed,
              aheadTarget,
              { worktreePath, baseRef: compare.baseRef },
            ),
          );

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

          if (status.unstaged.length > 0) {
            nodes.push(
              new SectionItem(
                'Unstaged',
                'unstaged',
                worktreePath,
                compare.baseRef,
                vscode.TreeItemCollapsibleState.Expanded,
                String(status.unstaged.length),
              ),
            );
          }

          // Context keys for Commit menu enablement
          void vscode.commands.executeCommand(
            'setContext',
            'worktreeCompare.hasStaged',
            status.staged.length > 0,
          );
          void vscode.commands.executeCommand(
            'setContext',
            'worktreeCompare.hasUnstaged',
            status.unstaged.length > 0,
          );

          nodes.push(
            new SectionItem(
              'Full Diff',
              'squash',
              worktreePath,
              compare.baseRef,
              vscode.TreeItemCollapsibleState.Collapsed,
              formatFileChangeBreakdown(compare.fullPrFiles),
            ),
          );
        }
      }
    }

    return nodes;
  }

  /** Worktrees shown in the list — the integration checkout lives under
   *  the Integration row instead. */
  private listedWorktrees(): DiscoveredWorktree[] {
    return this.worktrees.filter(
      (wt) => wt.path !== this.integration.getPath(),
    );
  }

  private getWorktreeListChildren(): TreeNode[] {
    const selected = this.getSelectedPath();
    const baseRef = integrationBaseRef();
    const state = this.integration.getState();
    return this.listedWorktrees().map((wt) => {
      const key = prCacheKey(wt.path, wt.branch);
      const pr = this.prCache.get(key);
      let integration: IntegrationRowInfo | undefined;
      if (state && !wt.detached && isLaneBranch(wt.branch, baseRef)) {
        integration = {
          role: 'lane',
          applied: state.lanes.includes(wt.branch),
          candidate: state.candidates.includes(wt.branch),
        };
      }
      const baseStatus = this.baseStatus.status(wt.path);
      return new WorktreeListItem(
        wt,
        wt.path === selected,
        pr ?? undefined,
        integration,
        baseStatus &&
        (baseStatus.behind > 0 ||
          baseStatus.conflicts ||
          baseStatus.rebasing ||
          baseStatus.merging)
          ? baseStatus
          : undefined,
      );
    });
  }

  /** Commits ahead of compare point (merge-base of integration tip by default). */
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

    if (item.section === 'unstaged') {
      return snap.status.unstaged.map(
        (f) =>
          new FileItem(item.worktreePath, item.baseRef, f, {
            diffKind: 'vsHead',
            statusSide: 'unstaged',
          }),
      );
    }

    // Full Diff (working tree ↔ base)
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
      nodes.push(new FolderItem(worktreePath, baseRef, folderPath));
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
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
    this._onDidChangeWorktrees.dispose();
    this._onGitActivity.dispose();
  }
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
    compare.compareRef,
    compare.baseHead,
    compare.compareIsTip ? '1' : '0',
    compare.ahead,
    compare.tipBehind,
    compare.commitsAhead.map((c) => c.hash).join(','),
    fmt(status.staged),
    fmt(status.unstaged),
    fmt(compare.fullPrFiles),
  ].join('::');
}
