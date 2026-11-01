import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  discoverWorktrees,
  isDirectChildOfWatchRoot,
  type DiscoveredWorktree,
} from '../git/discovery';
import {
  compareRefToBase,
  compareWorkingTreeToBase,
  formatFileChangeBreakdown,
  listCommitFiles,
  listRecentCommits,
  type CompareResult,
  type FileChange,
} from '../git/compare';
import {
  previewBaseRef,
  isLaneBranch,
  type AbsorbResult,
  type RebuildResult,
} from '../git/preview';
import {
  parseStoredRefFocus,
  refExists,
  refFocusBase,
  refFocusTips,
  type RefFocus,
} from '../git/refFocus';
import { getWorkingStatus, type WorkingStatus } from '../git/status';
import {
  openPullRequestBase,
  prHasMergeConflicts,
  type PullRequestInfo,
} from '../github/pr';
import { resetGithubPrClient } from '../github/gh';
import { PullRequestIndex } from '../github/prIndex';
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
  folderAutoExpands,
  isPathInside,
  joinPrefix,
  shouldIgnoreHotFollowPath,
} from './paths';
import { WorktreeRowDecorationProvider } from './worktreeDecorations';
import { lanesLayout } from './lanesLayout';
import { LoadMoreItem } from './nodes/stacks';
import { buildCombined } from '../git/combined';
import { TipWatch } from '../git/tipWatch';

const SELECTED_PATH_KEY = 'worktreeCompare.selectedPath';
/**
 * A branch focused by its ref, when one is. Its own key rather than a new
 * shape for the old one: `selectedPath` stays a plain path, so a state
 * written before refs could be focused still reads, and so does a ref
 * focus being dropped — the checkout it was standing on is still there.
 */
const FOCUSED_REF_KEY = 'worktreeCompare.focusedRef';
const COMBINED_KEY = 'combined';

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
  /** Open-PR base per checkout as last seen (see onPullRequestsChanged). */
  private prBases = new Map<string, string>();
  private readonly compareErrors = new Map<string, string>();

  private selectedPath: string | undefined;
  /**
   * Set while Focus shows a branch with no checkout. It wins over
   * selectedPath, which is kept so dropping the ref returns to the
   * checkout that was focused before it.
   */
  private focusedRef: RefFocus | undefined;
  /** Change Base Ref for focused refs, by ref (they have no path to key on). */
  private readonly refBaseOverrides = new Map<string, string>();
  /** `<ref sha> <base sha>` the cached ref snapshot was computed at. */
  private readonly refTips = new Map<string, string>();
  /** HEAD of the focused checkout, and the parts of a combined focus. */
  private readonly tipWatch = new TipWatch();
  /**
   * Bumped when the Full Diff tree layout or its auto-expand limit changes,
   * and folded into folder ids. VS Code keeps a folder's expansion per id
   * and ignores the initial state of one it has seen, so without this a
   * list → tree toggle would show whatever the folders were left as last
   * time instead of the auto-expand rule. Focusing something else bumps
   * it too, since folder paths repeat from branch to branch. Soft
   * refreshes keep it, so a folder the user collapsed stays collapsed
   * while they work.
   */
  private layoutGeneration = 0;
  /** Commits a history focus shows (see getHistoryRows). */
  private historyCount = HISTORY_PAGE;
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
    /** Shared with the Branches panel: one repo-wide PR query serves both. */
    prIndex: PullRequestIndex = new PullRequestIndex(output),
  ) {
    this.poll = new HotFollowPoll(output, (reason) =>
      this.softRefreshSelected(reason),
    );
    this.prs = new PullRequestCache(
      output,
      () => this.onPullRequestsChanged(),
      prIndex,
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
      extensionPath: () => context.extensionPath,
    });
    this.baseStatus = new BaseStatusTracker({
      output,
      getWorktrees: () => this.worktrees,
      listedWorktrees: () => this.listedWorktrees(),
      fallbackBaseRef: () => this.compareFallbackBaseRef(),
      pullRequestBaseFor: (p, branch) =>
        openPullRequestBase(this.prs.get(p, branch)),
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
        void this.refreshFocusedRefIfMoved();
        void this.refreshSelectedIfHeadMoved();
      },
      onActivity: () => this._onGitActivity.fire(),
      onRefreshRequested: (reason) => {
        this.output.appendLine(`Refresh requested (${reason})`);
        this.refresh();
      },
    });

    this.selectedPath = context.workspaceState.get<string>(SELECTED_PATH_KEY);
    this.focusedRef = parseStoredRefFocus(
      context.workspaceState.get(FOCUSED_REF_KEY),
    );
    this.syncSelectionDecorations();
    this.disposables.push(
      this.selectionDecorations,
      this.poll,
      this.preview,
      this.activity,
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.activity.restart();
        this.refresh();
      }),
      // Nothing is asked of GitHub while nobody is looking (see
      // PullRequestIndex), so coming back to the window is when a stale
      // badge gets to catch up.
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) void this.refreshPullRequests();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('worktreeCompare')) {
          if (e.affectsConfiguration('worktreeCompare.watchFolders'))
            this.activity.restartPoll();
          this.poll.restart();
          if (e.affectsConfiguration('worktreeCompare.githubPullRequests')) {
            resetGithubPrClient();
            this.prs.clear();
            void this.refreshPullRequests(true);
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
            e.affectsConfiguration('worktreeCompare.treeAutoExpandMaxChildren')
          ) {
            this.layoutGeneration++;
            const sel = this.getSelectedPath();
            if (sel) this.refreshCompare(sel);
          } else if (
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

  /**
   * The focused CHECKOUT. Undefined while a ref is focused, which is what
   * keeps every "act on the selected worktree" command — commit, stage,
   * terminal — from landing on some other checkout instead.
   */
  getSelected(): DiscoveredWorktree | undefined {
    if (this.focusedRef || this.worktrees.length === 0) return undefined;
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

  /**
   * A manual base set on a PR lane lasts only while you stay on it: leaving
   * — for another checkout or for a ref — drops it, so coming back finds
   * the PR's base again. Lanes without a PR keep theirs.
   */
  private leaveFocus(next: { path?: string; ref?: string }): void {
    const ref = this.focusedRef;
    if (ref) {
      // While a ref is focused, selectedPath is the lane left earlier.
      if (
        ref.ref !== next.ref &&
        ref.pr?.baseRefName &&
        this.refBaseOverrides.delete(ref.ref)
      ) {
        this.output.appendLine(
          `Base ref for ${ref.ref} → back to its PR's base (manual base ends on leaving)`,
        );
      }
      return;
    }
    const left = this.selectedPath;
    if (left && left !== next.path && this.baseStatus.dropOverrideOnLeave(left)) {
      this.snapshotCache.delete(left);
      this.output.appendLine(
        `Base ref for ${left} → back to its PR's base (manual base ends on leaving)`,
      );
    }
  }

  async setSelectedPath(worktreePath: string): Promise<void> {
    this.leaveFocus({ path: worktreePath });
    this.selectedPath = worktreePath;
    this.focusedRef = undefined;
    // A new subject applies the auto-expand rule afresh: folder ids repeat
    // across branches, and VS Code would replay the last one's state.
    this.layoutGeneration++;
    this.syncSelectionDecorations();
    await this.context.workspaceState.update(FOCUSED_REF_KEY, undefined);
    await this.context.workspaceState.update(SELECTED_PATH_KEY, worktreePath);
    this.output.appendLine(`Selected worktree → ${worktreePath}`);
    // Drop other snapshots so we don't grow unbounded; keep selected warm on next expand
    for (const key of [...this.snapshotCache.keys()]) {
      if (key !== worktreePath) this.snapshotCache.delete(key);
    }
    this._onDidChangeTreeData.fire();
    this._onDidChangeWorktrees.fire();
  }

  /** The branch focused by its ref, if Focus is showing one. */
  getFocusedRef(): RefFocus | undefined {
    return this.focusedRef;
  }

  /**
   * Focus a branch that has no checkout. The ref must already resolve —
   * fetching is the caller's, since it wants a progress notification.
   */
  async focusRef(focus: RefFocus): Promise<void> {
    this.leaveFocus({ ref: focus.ref });
    this.focusedRef = focus;
    this.layoutGeneration++;
    this.historyCount = HISTORY_PAGE;
    this.syncSelectionDecorations();
    await this.context.workspaceState.update(FOCUSED_REF_KEY, focus);
    this.output.appendLine(`Focused ref → ${focus.ref} (${focus.branch})`);
    // Built from these just now: record them, so only a later move rebuilds
    const cwd = this.getRepoCwd();
    if (focus.parts && cwd) await this.tipWatch.moved(COMBINED_KEY, cwd, focus.parts);
    // Always recompute: refocusing is how you ask for a fresh look
    this.snapshotCache.clear();
    this.compareErrors.delete(refSnapshotKey(focus));
    this._onDidChangeTreeData.fire();
    this._onDidChangeWorktrees.fire();
  }

  /**
   * The focused ref went away — deleted on the remote and pruned, or a
   * local branch deleted. Back to the checkout that was focused before,
   * the same fallback a removed worktree gets.
   */
  private dropFocusedRef(why: string): void {
    if (!this.focusedRef) return;
    this.output.appendLine(
      `Focused ref ${this.focusedRef.ref} dropped (${why})`,
    );
    this.focusedRef = undefined;
    void this.context.workspaceState.update(FOCUSED_REF_KEY, undefined);
    this.ensureValidSelection();
    this._onDidChangeTreeData.fire();
    this._onDidChangeWorktrees.fire();
  }

  private syncSelectionDecorations(): void {
    this.selectionDecorations.setSelectedPath(
      this.focusedRef ? undefined : this.selectedPath,
    );
    this.selectionDecorations.setSelectedBranch(this.focusedRef?.branch);
  }

  /** Selection landed on the preview checkout — move to a real lane. */
  private moveSelectionOff(worktreePath: string): void {
    const fallback = this.worktrees.find((w) => w.path !== worktreePath);
    this.selectedPath = fallback?.path;
    this.syncSelectionDecorations();
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
      this.syncSelectionDecorations();
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
    this.syncSelectionDecorations();
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
      const cwd = this.getRepoCwd();
      if (
        this.focusedRef &&
        cwd &&
        !(await refExists(cwd, this.focusedRef.ref))
      )
        this.dropFocusedRef('ref no longer exists');
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

  /**
   * The PR answer moved. Rows carry PR state, so the tree always redraws;
   * a checkout whose open PR's base changed (retargeted, opened, closed)
   * also has a different compare base now, so its snapshot is dropped and
   * the badges re-probed. No query of its own — this only reads the answer
   * the cache just stored.
   */
  private onPullRequestsChanged(): void {
    const next = new Map<string, string>();
    for (const wt of this.worktrees) {
      const base = openPullRequestBase(this.prs.get(wt.path, wt.branch));
      if (base) next.set(wt.path, base);
    }
    const paths = new Set([...next.keys(), ...this.prBases.keys()]);
    const changed = [...paths].filter(
      (p) => next.get(p) !== this.prBases.get(p),
    );
    this.prBases = next;
    if (changed.length > 0) {
      for (const p of changed) {
        if (this.baseStatus.getOverride(p)) continue;
        this.snapshotCache.delete(p);
        this.compareErrors.delete(p);
      }
      this.output.appendLine(
        `PR base changed for ${changed.map((p) => path.basename(p)).join(', ')} — re-resolving compare base`,
      );
      void this.baseStatus.refresh();
    }
    this._onDidChangeTreeData.fire();
  }

  /** Drop PR cache so the next lookup re-queries `gh`. */
  clearPullRequestCache(): void {
    this.prs.clear();
  }

  /**
   * Associate PRs with the discovered checkouts.
   *
   * Called on every discovery load, most of which are triggered by things
   * that cannot have changed a PR — a file appearing under `.worktrees`, a
   * ref moving. So the default is a *request*, which the index answers from
   * its last query unless the window has lapsed; `force` is the explicit
   * Refresh Pull Requests command, which always asks.
   */
  refreshPullRequests(force = false): Promise<void> {
    return this.prs.refresh(this.worktrees, this.getRepoCwd(), force);
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
   * Cheap content refresh: only re-run status/diff. The base comes from
   * baseFor, which is a cache hit unless something moved it (a PR
   * retargeted, a full refresh) — never the previous snapshot's base,
   * which is exactly what kept a changed base from being picked up.
   */
  private async softRefreshSelected(reason: string): Promise<void> {
    const worktreePath = this.getSelectedPath();
    if (!worktreePath || this.loading || this.softRefreshInFlight) return;
    this.softRefreshInFlight = true;
    try {
      const prev = this.snapshotCache.get(worktreePath);
      const prevFp = prev ? snapshotFingerprint(prev) : undefined;
      const baseRef = await this.worktreeBaseFor(worktreePath);

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

  // ---- focused ref (a branch with no checkout) ------------------------------

  /**
   * Snapshot for a focused ref: the same shape a checkout gets, with empty
   * staged/unstaged — there is no working tree for anything to be
   * uncommitted in. Keyed apart from every checkout path, since its
   * worktreePath on the rows is just the repo cwd its git runs in.
   */
  private async getRefSnapshot(
    focus: RefFocus,
  ): Promise<WorktreeSnapshot | undefined> {
    const key = refSnapshotKey(focus);
    const cached = this.snapshotCache.get(key);
    if (cached) return cached;
    const cwd = this.getRepoCwd();
    if (!cwd) return undefined;
    const t0 = Date.now();
    try {
      const baseRef = await this.refBaseFor(cwd, focus);
      const [compare, tips] = await Promise.all([
        compareRefToBase(cwd, focus.ref, baseRef),
        refFocusTips(cwd, focus.ref, baseRef),
      ]);
      this.output.appendLine(
        `Snapshot ${focus.ref}: base=${baseRef} ahead=${compare.ahead} files=${compare.fullPrFiles.length} (${Date.now() - t0}ms)`,
      );
      const snap: WorktreeSnapshot = {
        compare,
        status: { staged: [], unstaged: [] },
      };
      this.snapshotCache.set(key, snap);
      this.refTips.set(key, tips);
      this.compareErrors.delete(key);
      return snap;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Snapshot failed for ${focus.ref}: ${message}`);
      this.compareErrors.set(key, message);
      // Gone rather than broken: fall back instead of showing an error
      // about a branch that no longer exists.
      if (!(await refExists(cwd, focus.ref)))
        this.dropFocusedRef('ref no longer exists');
      return undefined;
    }
  }

  private refBaseFor(cwd: string, focus: RefFocus): Promise<string> {
    const override = this.refBaseOverrides.get(focus.ref);
    if (override) return Promise.resolve(override);
    return refFocusBase(cwd, focus, this.compareFallbackBaseRef());
  }

  /**
   * A fetch moves a remote-tracking ref without touching any checkout, so
   * nothing else would notice the focused ref changed. Cheap: one
   * rev-parse per git tick, and a recompute only when a tip moved.
   */
  private async refreshFocusedRefIfMoved(): Promise<void> {
    const focus = this.focusedRef;
    const cwd = this.getRepoCwd();
    if (!focus || !cwd) return;
    if (focus.parts) return this.rebuildCombinedIfMoved(cwd, focus, focus.parts);
    const key = refSnapshotKey(focus);
    const snap = this.snapshotCache.get(key);
    if (!snap) return;
    try {
      const tips = await refFocusTips(cwd, focus.ref, snap.compare.baseRef);
      if (tips === this.refTips.get(key)) return;
      this.output.appendLine(`Focused ref ${focus.ref} moved — recompare`);
    } catch {
      // Unresolvable: getRefSnapshot decides whether it is gone
    }
    this.snapshotCache.delete(key);
    this._onDidChangeTreeData.fire();
  }

  /**
   * A combined focus is a commit built once from its parts, so a commit on
   * any of them leaves it behind. Rebuilt in place: same subject, so the
   * tree keeps whatever was expanded.
   */
  private async rebuildCombinedIfMoved(
    cwd: string,
    focus: RefFocus,
    parts: string[],
  ): Promise<void> {
    if (!(await this.tipWatch.moved(COMBINED_KEY, cwd, parts))) return;
    this.output.appendLine(`Combined parts moved — rebuild ${parts.join(' + ')}`);
    try {
      const combined = await buildCombined(cwd, parts);
      if (this.focusedRef !== focus) return; // focus moved on meanwhile
      this.focusedRef = {
        ...focus,
        base: combined.base,
        conflicts: combined.conflicts.length ? combined.conflicts : undefined,
      };
      await this.context.workspaceState.update(FOCUSED_REF_KEY, this.focusedRef);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Combined rebuild failed: ${message}`);
      this.tipWatch.forget(COMBINED_KEY); // try again next tick
      return;
    }
    this.snapshotCache.delete(refSnapshotKey(focus));
    this._onDidChangeTreeData.fire();
  }

  /**
   * A commit made in the focused checkout — by an agent in a terminal, say —
   * moves its HEAD without any editor event, and the content poll is off by
   * default. The git tick is the signal; this asks whether it was ours.
   */
  private async refreshSelectedIfHeadMoved(): Promise<void> {
    if (this.focusedRef) return;
    const path = this.getSelectedPath();
    if (!path) return;
    // First sight counts as moved: a commit may have landed between the
    // snapshot and now, and softRefresh redraws only on a real difference.
    if (!(await this.tipWatch.moved(`checkout:${path}`, path, ['HEAD']))) return;
    this.output.appendLine(`HEAD moved in ${path} — refresh Focus`);
    await this.softRefreshSelected('head moved');
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

  /** Change Base Ref for the focused ref (it has no path to key on). */
  setFocusedRefBase(baseRef: string): void {
    const focus = this.focusedRef;
    if (!focus) return;
    this.refBaseOverrides.set(focus.ref, baseRef);
    this.snapshotCache.delete(refSnapshotKey(focus));
    this.compareErrors.delete(refSnapshotKey(focus));
    this.output.appendLine(`Base ref for ${focus.ref} → ${baseRef}`);
    this._onDidChangeTreeData.fire();
  }

  getFocusedRefBase(): string | undefined {
    const focus = this.focusedRef;
    if (!focus) return undefined;
    return (
      this.refBaseOverrides.get(focus.ref) ??
      this.snapshotCache.get(refSnapshotKey(focus))?.compare.baseRef
    );
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
    } else if (this.focusedRef) {
      nodes.push(...(await this.getRefRootChildren(this.focusedRef)));
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
          const stacks = lanesLayout() === 'stacks';
          // Under stacks a branch row is a leaf, so this is where its
          // commits are read — open, not one more click away.
          nodes.push(
            new GroupItem(
              `Commits · ${aheadCount}`,
              'ahead',
              stacks
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed,
              shortShas(aheadTarget),
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
            stacks
              ? filesSection(worktreePath, compare)
              : new SectionItem(
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
   * Focus for a branch with no checkout: Commits and Full Diff, nothing
   * else. Staged / Unstaged and Directory describe a working tree, and
   * there is none — read-only is the honest shape, and Create Worktree in
   * the title bar is the way to get a writable one.
   */
  private async getRefRootChildren(focus: RefFocus): Promise<TreeNode[]> {
    if (focus.history) return this.getHistoryRows(focus);
    const snap = await this.getRefSnapshot(focus);
    if (!snap) {
      // Dropped while loading — the checkout it fell back to renders next
      if (!this.focusedRef) return [];
      const err =
        this.compareErrors.get(refSnapshotKey(focus)) ?? 'Failed to load';
      return [new MessageItem('Could not load branch', err, 'error')];
    }
    const cwd = this.getRepoCwd() ?? '';
    const { compare } = snap;
    // Write actions key off these; a ref has nothing to stage or commit
    void vscode.commands.executeCommand(
      'setContext',
      'worktreeCompare.hasStaged',
      false,
    );
    void vscode.commands.executeCommand(
      'setContext',
      'worktreeCompare.hasUnstaged',
      false,
    );
    const conflicts = (focus.conflicts ?? []).map(
      (p) => new MessageItem(p, 'conflict', 'warning'),
    );
    if (lanesLayout() === 'stacks') {
      return [
        ...conflicts,
        new GroupItem(
          `Commits · ${compare.ahead}`,
          'ahead',
          vscode.TreeItemCollapsibleState.Expanded,
          shortShas(
            compare.compareIsTip
              ? `→ ${compare.baseRef}`
              : `→ ${compare.baseRef} @ ${compare.baseHead}`,
          ),
          { baseRef: compare.baseRef },
        ),
        filesSection(cwd, compare),
      ];
    }
    return [
      new GroupItem(
        `Commits · ${compare.ahead}`,
        'ahead',
        vscode.TreeItemCollapsibleState.Collapsed,
        compare.compareIsTip
          ? `→ ${compare.baseRef}`
          : `→ ${compare.baseRef} @ ${compare.baseHead}`,
        // No worktreePath: Change Base Ref reads that as "the focused ref"
        { baseRef: compare.baseRef },
      ),
      new SectionItem(
        'Full Diff',
        'squash',
        cwd,
        compare.baseRef,
        vscode.TreeItemCollapsibleState.Collapsed,
        formatFileChangeBreakdown(compare.fullPrFiles),
      ),
    ];
  }

  /**
   * A ref's own history, newest first — what Focus shows for the trunk,
   * which has no base to diff against. Each commit opens into its files.
   */
  private async getHistoryRows(focus: RefFocus): Promise<TreeNode[]> {
    const cwd = this.getRepoCwd();
    if (!cwd) return [];
    const commits = await listRecentCommits(cwd, focus.ref, this.historyCount + 1);
    const rows: TreeNode[] = commits
      .slice(0, this.historyCount)
      .map((c) => new CommitItem(cwd, focus.ref, c));
    if (commits.length > this.historyCount) rows.push(new LoadMoreItem());
    return rows;
  }

  /** Page in older history for a focused trunk. */
  loadMoreHistory(): void {
    this.historyCount += HISTORY_PAGE;
    this._onDidChangeTreeData.fire();
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
    if (this.focusedRef) {
      const snap = await this.getRefSnapshot(this.focusedRef);
      if (!snap) return [];
      if (snap.compare.commitsAhead.length === 0)
        return [new MessageItem('No commits ahead of base', snap.compare.baseRef)];
      const cwd = this.getRepoCwd() ?? '';
      return snap.compare.commitsAhead.map(
        (c) => new CommitItem(cwd, snap.compare.baseRef, c),
      );
    }
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
    const snap = await this.snapshotForItem(item.worktreePath);
    if (!snap) return [];
    const refs = this.refDiffSides(snap);

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
        refs,
      );
    }
    return snap.compare.fullPrFiles.map(
      (f) =>
        new FileItem(item.worktreePath, item.baseRef, f, {
          diffKind: refs ? 'ref' : 'vsBase',
          refs,
        }),
    );
  }

  private async getFolderChildren(item: FolderItem): Promise<TreeNode[]> {
    const snap = await this.snapshotForItem(item.worktreePath);
    if (!snap) return [];
    return this.buildFolderLevel(
      item.worktreePath,
      item.baseRef,
      snap.compare.fullPrFiles,
      item.folderPath,
      this.refDiffSides(snap),
    );
  }

  /**
   * Snapshot behind a Full Diff row. With a ref focused the row's
   * worktreePath is only the cwd its git runs in — usually the root
   * checkout's own path — so it cannot be the key.
   */
  private snapshotForItem(
    worktreePath: string,
  ): Promise<WorktreeSnapshot | undefined> {
    return this.focusedRef
      ? this.getRefSnapshot(this.focusedRef)
      : this.getSnapshot(worktreePath);
  }

  /** Fork point ↔ tip, when the rows are a focused ref's. */
  private refDiffSides(
    snap: WorktreeSnapshot,
  ): { left: string; right: string } | undefined {
    if (!this.focusedRef) return undefined;
    return { left: snap.compare.baseHead, right: this.focusedRef.ref };
  }

  private squashLayout(): 'list' | 'tree' {
    const v = vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<string>('squashLayout', 'list');
    return v === 'tree' ? 'tree' : 'list';
  }

  private treeAutoExpandMaxChildren(): number {
    const v = vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<number>('treeAutoExpandMaxChildren', 9);
    return typeof v === 'number' && Number.isFinite(v) ? v : 8;
  }

  private buildFolderLevel(
    worktreePath: string,
    baseRef: string,
    files: FileChange[],
    prefix: string,
    refs?: { left: string; right: string },
  ): TreeNode[] {
    const level = childrenAtPrefix(files, prefix);
    const max = this.treeAutoExpandMaxChildren();
    const nodes: TreeNode[] = [];
    for (const dir of level.dirs) {
      const folderPath = joinPrefix(prefix, dir);
      nodes.push(
        new FolderItem(worktreePath, baseRef, folderPath, {
          state: folderAutoExpands(files, folderPath, max)
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
          generation: this.layoutGeneration,
        }),
      );
    }
    for (const f of level.files) {
      nodes.push(
        new FileItem(worktreePath, baseRef, f, {
          diffKind: refs ? 'ref' : 'vsBase',
          refs,
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

function refSnapshotKey(focus: RefFocus): string {
  return `ref:${focus.ref}`;
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

/**
 * The diff, as Focus shows it under the stacks layout: every file, open,
 * with what it is measured against in the description — the Commits row
 * that used to carry the base is a Lanes row now.
 */
function filesSection(
  worktreePath: string,
  compare: CompareResult,
): SectionItem {
  const target = compare.compareIsTip
    ? shortShas(compare.baseRef)
    : `${shortShas(compare.baseRef)} @ ${shortShas(compare.baseHead)}`;
  const breakdown = formatFileChangeBreakdown(compare.fullPrFiles);
  return new SectionItem(
    `Files · ${compare.fullPrFiles.length}`,
    'squash',
    worktreePath,
    compare.baseRef,
    vscode.TreeItemCollapsibleState.Expanded,
    `→ ${target}${breakdown ? ` · ${breakdown}` : ''}`,
  );
}

/** A commit's or a combination's base is a bare sha; keep it short. */
function shortShas(text: string): string {
  return text.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1');
}

/** Trunk commits a history focus shows at first, and each Load more adds. */
const HISTORY_PAGE = 10;
