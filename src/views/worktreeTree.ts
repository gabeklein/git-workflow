import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  discoverWorktrees,
  isDirectChildOfWatchRoot,
  type DiscoveredWorktree,
} from '../git/discovery';
import {
  compareWorkingTreeToBase,
  formatFileChangeBreakdown,
  listCommitFiles,
  type CompareResult,
  type FileChange,
} from '../git/compare';
import {
  previewBaseRef,
  isLaneBranch,
  type AbsorbResult,
  type RebuildResult,
} from '../git/preview';
import { getWorkingStatus, type WorkingStatus } from '../git/status';
import {
  prHasMergeConflicts,
  resetGithubPrClient,
  type PullRequestInfo,
} from '../github/pr';
import { BaseStatusTracker } from './baseStatusTracker';
import { GitActivityHub } from './gitActivityHub';
import { HotFollowPoll } from './hotFollowPoll';
import { PullRequestCache } from './pullRequestCache';
import {
  PreviewController,
  type PreviewState,
} from './previewController';
import { GroupItem, MessageItem, SectionItem, type TreeNode } from './nodes';
import { FileItem, FolderItem } from './nodes/files';
import {
  CommitItem,
  ConflictWarningItem,
  WorktreeListItem,
  type LandedRowInfo,
  type PreviewRowInfo,
} from './nodes/worktrees';
import {
  childrenAtPrefix,
  isPathInside,
  joinPrefix,
  shouldIgnoreHotFollowPath,
} from './paths';
import { WorktreeRowDecorationProvider } from './worktreeDecorations';

const SELECTED_PATH_KEY = 'worktreeCompare.selectedPath';

interface WorktreeSnapshot {
  compare: CompareResult;
  status: WorkingStatus;
}

/**
 * Composition root for the Worktree panel:
 *   discovery + selection + compare snapshots (hot-follow) + PR badges,
 * with the preview overlay (PreviewController), base badges
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
  private contentDebounce: NodeJS.Timeout | undefined;
  private softRefreshInFlight = false;

  private readonly snapshotCache = new Map<string, WorktreeSnapshot>();
  private readonly compareErrors = new Map<string, string>();

  private selectedPath: string | undefined;
  private readonly selectionDecorations =
    new WorktreeRowDecorationProvider();

  private readonly poll: HotFollowPoll;
  private readonly prs: PullRequestCache;
  private readonly preview: PreviewController;
  private readonly baseStatus: BaseStatusTracker;
  private readonly activity: GitActivityHub;

  constructor(
    private readonly output: { appendLine(value: string): void },
    private readonly context: vscode.ExtensionContext,
  ) {
    this.poll = new HotFollowPoll(output, (reason) =>
      this.softRefreshSelected(reason),
    );
    this.prs = new PullRequestCache(output, () =>
      this._onDidChangeTreeData.fire(),
    );
    this.preview = new PreviewController({
      output,
      getWorktrees: () => this.worktrees,
      getRepoCwd: () => this.getRepoCwd(),
      getSelectedPath: () => this.selectedPath,
      fireTreeData: () => {
        this.syncAppliedDecorations();
        this._onDidChangeTreeData.fire();
      },
      refresh: () => this.refresh(),
      refreshCompare: (p) => this.refreshCompare(p),
      moveSelectionOff: (p) => this.moveSelectionOff(p),
      genuineBaseFor: (p) => this.baseStatus.genuineBaseFor(p),
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
        await this.preview.tick();
        void this.baseStatus.refresh();
      },
      onActivity: () => this._onGitActivity.fire(),
    });

    this.selectedPath = context.workspaceState.get<string>(SELECTED_PATH_KEY);
    this.selectionDecorations.setSelectedPath(this.selectedPath);
    this.disposables.push(
      this.selectionDecorations,
      this.poll,
      this.preview,
      this.activity,
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.activity.restart();
        this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('worktreeCompare')) {
          if (e.affectsConfiguration('worktreeCompare.watchFolders'))
            this.activity.restartPoll();
          this.poll.restart();
          if (e.affectsConfiguration('worktreeCompare.githubPullRequests')) {
            resetGithubPrClient();
            this.prs.clear();
            void this.refreshPullRequests();
          }
          if (
            e.affectsConfiguration('worktreeCompare.watchFolders') ||
            e.affectsConfiguration('worktreeCompare.previewBranch')
          ) {
            this.refresh();
          } else if (
            e.affectsConfiguration('worktreeCompare.previewBaseRef')
          ) {
            void this.preview.handleBaseChange();
          } else if (
            e.affectsConfiguration('worktreeCompare.squashLayout') ||
            e.affectsConfiguration('worktreeCompare.defaultBaseRef')
          ) {
            const sel = this.getSelectedPath();
            if (sel) this.refreshCompare(sel);
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
        this.preview.scheduleWipRebuildIfUnderWipLane(doc.uri);
      }),
      vscode.workspace.onDidCreateFiles((e) => {
        for (const u of e.files) {
          this.scheduleDiscoverIfWatchRootChild(u);
          this.scheduleSoftRefreshIfUnderSelected(u);
          this.preview.scheduleWipRebuildIfUnderWipLane(u);
        }
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const u of e.files) {
          this.scheduleDiscoverIfWatchRootChild(u);
          this.scheduleSoftRefreshIfUnderSelected(u);
          this.preview.scheduleWipRebuildIfUnderWipLane(u);
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          this.scheduleDiscoverIfWatchRootChild(f.newUri);
          this.scheduleDiscoverIfWatchRootChild(f.oldUri);
          this.scheduleSoftRefreshIfUnderSelected(f.newUri);
          this.scheduleSoftRefreshIfUnderSelected(f.oldUri);
          this.preview.scheduleWipRebuildIfUnderWipLane(f.newUri);
          this.preview.scheduleWipRebuildIfUnderWipLane(f.oldUri);
        }
      }),
    );
    void this.activity.restart();
    this.poll.restart();
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
    if (this.worktrees.length === 0) return undefined;
    if (this.selectedPath) {
      const hit = this.worktrees.find((w) => w.path === this.selectedPath);
      if (hit) return hit;
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
      if (key !== worktreePath) this.snapshotCache.delete(key);
    }
    this._onDidChangeTreeData.fire();
    this._onDidChangeWorktrees.fire();
  }

  /** Selection landed on the preview checkout — move to a real lane. */
  private moveSelectionOff(worktreePath: string): void {
    const fallback = this.worktrees.find((w) => w.path !== worktreePath);
    this.selectedPath = fallback?.path;
    this.selectionDecorations.setSelectedPath(this.selectedPath);
    void this.context.workspaceState.update(
      SELECTED_PATH_KEY,
      this.selectedPath,
    );
    this.output.appendLine(
      `Selection moved off preview checkout → ${this.selectedPath ?? '(none)'}`,
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
      // Prefer a real worktree; the preview checkout only via clicks
      const first =
        this.worktrees.find((w) => w.path !== this.preview.getPath()) ??
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
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
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
      this.prs.prune(this.worktrees);
      await this.preview.refreshState();
      void this.baseStatus.refresh();
      this.output.appendLine(
        `Load done: ${this.worktrees.length} worktree(s), selected=${this.selectedPath ?? '(none)'} (${Date.now() - t0}ms)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Discovery failed: ${message}`);
      this.worktrees = [];
      this.prs.clear();
    } finally {
      this.loading = false;
      // Paths changed, so the applied-lane badges have to be recomputed even
      // when preview state itself did not move.
      this.syncAppliedDecorations();
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
    if (uri.scheme !== 'file') return;
    if (!isDirectChildOfWatchRoot(uri.fsPath)) return;
    this.refresh();
  }

  // ---- PR badges -----------------------------------------------------------

  /** Cached PR for a worktree row (if looked up). */
  getPullRequest(worktreePath: string): PullRequestInfo | undefined {
    const wt = this.worktrees.find((w) => w.path === worktreePath);
    return wt && this.prs.get(wt.path, wt.branch);
  }

  /** Drop PR cache so the next lookup re-queries `gh`. */
  clearPullRequestCache(): void {
    this.prs.clear();
  }

  refreshPullRequests(): Promise<void> {
    return this.prs.refresh(this.worktrees);
  }

  // ---- hot-follow compare (selected worktree) ------------------------------

  private scheduleSoftRefreshIfUnderSelected(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') return;
    const selected = this.getSelected();
    if (!selected || !isPathInside(uri.fsPath, selected.path)) return;
    // Root monorepo checkout: ignore high-churn / irrelevant paths so every
    // node_modules or dist write does not trigger git status.
    if (shouldIgnoreHotFollowPath(uri.fsPath, selected.path)) return;
    // File activity → mark active (poll pace, if enabled)
    this.poll.markActive('file-event');
    if (this.contentDebounce) clearTimeout(this.contentDebounce);
    // Longer debounce: agent bursts can write many files in one go
    this.contentDebounce = setTimeout(() => {
      this.contentDebounce = undefined;
      void this.softRefreshSelected('file-event');
    }, 800);
  }

  /**
   * Cheap content refresh: reuse cached baseRef; only re-run status/diff.
   * Avoids resolveBaseRef on every tick (that path was hang-prone).
   */
  private async softRefreshSelected(reason: string): Promise<void> {
    const worktreePath = this.getSelectedPath();
    if (!worktreePath || this.loading || this.softRefreshInFlight) return;
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
        this.poll.relax();
        return;
      }
      this.poll.markActive(reason);
      this.output.appendLine(
        `Hot-follow update (${reason}, pace=${this.poll.currentPace}): ${path.basename(worktreePath)}`,
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
    if (cached) return cached;
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
   * Fallback for compare-base inference. While preview is active,
   * lanes land on the preview base, so it is the sane default —
   * per-worktree inference (reflog/upstream) and overrides still win.
   */
  private compareFallbackBaseRef(): string {
    return this.preview.getPath()
      ? previewBaseRef()
      : this.defaultBaseRef();
  }

  // ---- preview (delegates) ---------------------------------------------

  getPreview(): PreviewState | undefined {
    return this.preview.getState();
  }

  runPreviewRebuild(reason: string): Promise<RebuildResult> {
    return this.preview.runRebuild(reason);
  }

  catchUpPreviewBase(): Promise<RebuildResult> {
    return this.preview.catchUpBase();
  }

  setBaseDriftIncluded(included: boolean): Promise<RebuildResult> {
    return this.preview.setBaseDriftIncluded(included);
  }

  addPreviewCandidate(branch: string): Promise<void> {
    return this.preview.addCandidate(branch);
  }

  removePreviewCandidate(branch: string): Promise<RebuildResult> {
    return this.preview.removeCandidate(branch);
  }

  applyToPreview(branch: string): Promise<RebuildResult> {
    return this.preview.apply(branch);
  }

  hideFromPreview(branch: string): Promise<RebuildResult> {
    return this.preview.hide(branch);
  }

  setLaneWip(branch: string, enabled: boolean): Promise<RebuildResult> {
    return this.preview.setLaneWip(branch, enabled);
  }

  abortPreviewMerge(): Promise<void> {
    return this.preview.abortMerge();
  }

  /** Move a lane in the merge order (drag-and-drop), then rebuild. */
  reorderLane(lane: string, before?: string): Promise<void> {
    return this.preview.reorderLane(lane, before);
  }

  /** Absorb approved stray COMMITS from the preview checkout. */
  absorbPreviewCommits(): Promise<AbsorbResult | undefined> {
    return this.preview.absorbStraysConfirmed();
  }

  /** Move uncommitted preview-checkout edits onto the base. */
  absorbPreviewEdits(): Promise<AbsorbResult> {
    return this.preview.absorbEdits();
  }

  // ---- rendering ------------------------------------------------------------

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) {
      return []; // worktree rows are leaves; details live in the Changes view
    }
    if (this.loading && this.worktrees.length === 0)
      return [new MessageItem('Scanning worktrees…', undefined, 'loading~spin')];
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
      if (!element) return await this.getChangesRootChildren();
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

  /**
   * Tell the decoration provider what is in the preview — checkout paths
   * for rows that have one, branch names for the rest, since a row keys its
   * decoration on whichever it carries.
   */
  private syncAppliedDecorations(): void {
    const applied = new Set(this.preview.getState()?.lanes ?? []);
    const withCheckout = this.worktrees.filter(
      (w) => !w.detached && applied.has(w.branch),
    );
    this.selectionDecorations.setApplied({
      paths: withCheckout.map((w) => w.path),
      // A lane needs no worktree — it is merged from its ref — so applied
      // branches without a checkout are badged on their branch row instead.
      branches: applied,
    });
  }

  private listedWorktrees(): DiscoveredWorktree[] {
    return this.worktrees.filter(
      (wt) => wt.path !== this.preview.getPath(),
    );
  }

  private getWorktreeListChildren(): TreeNode[] {
    return this.listedWorktrees().map((wt) => this.buildCheckoutRow(wt));
  }

  /**
   * One checkout row, with its PR, lane role and base status attached.
   * Public so the Focus panel can order the checkouts itself and still get
   * rows built the one way.
   */
  buildCheckoutRow(wt: DiscoveredWorktree, landed?: LandedRowInfo): TreeNode {
    const selected = this.getSelectedPath();
    const baseRef = previewBaseRef();
    const state = this.preview.getState();
    return ((): TreeNode => {
      const pr = this.prs.get(wt.path, wt.branch);
      let preview: PreviewRowInfo | undefined;
      if (state && !wt.detached && isLaneBranch(wt.branch, baseRef)) {
        preview = {
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
        preview,
        baseStatus &&
        (baseStatus.behind > 0 ||
          baseStatus.conflicts ||
          baseStatus.rebasing ||
          baseStatus.merging)
          ? baseStatus
          : undefined,
        landed,
      );
    })();
  }

  /** Commits ahead of compare point (merge-base of preview tip by default). */
  private async getAheadChildren(): Promise<TreeNode[]> {
    const selected = this.getSelected();
    if (!selected) return [new MessageItem('Select a worktree above')];
    const snap = await this.getSnapshot(selected.path);
    if (!snap) {
      const err = this.compareErrors.get(selected.path) ?? 'Failed to load';
      return [new MessageItem('Could not load', err, 'error')];
    }

    const { compare } = snap;
    if (compare.commitsAhead.length === 0)
      return [new MessageItem('No commits ahead of base', compare.baseRef)];

    return compare.commitsAhead.map(
      (c) => new CommitItem(selected.path, compare.baseRef, c),
    );
  }

  private async getSectionChildren(item: SectionItem): Promise<TreeNode[]> {
    const snap = await this.getSnapshot(item.worktreePath);
    if (!snap) return [];

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
    if (snap.compare.fullPrFiles.length === 0)
      return [new MessageItem('No differences from base', item.baseRef)];
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
    if (!snap) return [];
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
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.contentDebounce) clearTimeout(this.contentDebounce);
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
