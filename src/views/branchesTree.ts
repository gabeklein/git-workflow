import * as vscode from 'vscode';
import { listBranches, type BranchInfo } from '../git/branches';
import type { FileChange } from '../git/compare';
import {
  isAutoRemoveLandedEnabled,
  isPruneRemoteRefsEnabled,
  previewBaseRef,
  previewBranch,
} from '../git/preview';
import { hasOrigin, pruneTrackingRefs } from '../git/remotePrune';
import {
  sweepLandedWorktrees,
  type LandedBlocker,
} from '../git/landedWorktrees';
import { findLandedBranches } from '../git/pruneLanded';
import {
  isGithubPrIntegrationEnabled,
  resetGithubPrClient,
} from '../github/pr';
import {
  listOpenRemotePullRequests,
  listRemotePrFiles,
  type RemotePullRequest,
} from '../github/remotePrs';
import type { DiscoveredWorktree } from '../git/discovery';
import { MessageItem, type TreeNode } from './nodes';
import { isPathInside } from './paths';
import { BranchItem, RemotePrFileItem } from './nodes/branches';

const MAX_ROWS = 50;
/**
 * Least time between remote prunes. A refresh is cheap and can fire in
 * bursts; asking origin what it still has is neither.
 */
const PRUNE_THROTTLE_MS = 60_000;

/**
 * Branches panel: every branch of the repo — local, remote, and PR-only
 * heads — newest first, tagged with worktree / PR / conflict status.
 * Create worktrees from any row; PR rows expand into read-only files.
 *
 * Local list is one git call, reloaded on git activity. PR association
 * (via gh) refreshes on demand and on config/workspace changes.
 */
export class BranchesTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private branches: BranchInfo[] = [];
  private branchesFingerprint = '';
  /**
   * Branches whose work is confirmed in the base — the Landed rung.
   *
   * Cached rather than computed per render: the probe walks base history
   * with off-tree merges, so it is cheap enough to run when the branch
   * list changes and far too expensive to run while drawing rows.
   */
  private landed = new Set<string>();
  /**
   * Landed branches whose checkout is STILL ON DISK, by checkout path,
   * with the reason the sweep left it there. Drives the `landed · …` badge
   * on the Working row — the thing that makes reclaimable disk visible.
   */
  private landedCheckouts = new Map<
    string,
    { branch: string; blocker: LandedBlocker }
  >();
  /** Guard: one sweep at a time, since a removal re-enters through .git. */
  private sweeping = false;
  private lastPruneAt = 0;
  private prsByHead = new Map<string, RemotePullRequest>();
  private worktrees: DiscoveredWorktree[] = [];
  private worktreeByBranch = new Map<string, string>();
  private loading = false;
  private error: string | undefined;
  private repoCwd: string | undefined;
  private readonly filesCache = new Map<
    number,
    { baseRef: string; headRef: string; files: FileChange[] }
  >();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly output: { appendLine(value: string): void }) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('worktreeCompare.githubPullRequests') ||
          e.affectsConfiguration('worktreeCompare.remotePrLimit')
        ) {
          resetGithubPrClient();
          this.filesCache.clear();
          this.refresh();
        }
      }),
    );
    this.refresh();
  }

  /** Sync from discovery so rows show/focus their worktrees. */
  setWorktrees(worktrees: DiscoveredWorktree[]): void {
    this.worktrees = worktrees;
    this.worktreeByBranch = new Map(
      worktrees.filter((w) => !w.detached).map((w) => [w.branch, w.path]),
    );
    this._onDidChangeTreeData.fire();
    // A checkout may have just appeared, or become clean, without the
    // branch list changing at all — so the sweep runs on discovery too and
    // not only when the landed answer moves.
    void this.sweepLanded();
  }

  /**
   * The landed checkout at `path`, if its folder is still there. Undefined
   * for an ordinary checkout, which is every row that has work left in it.
   */
  getLandedCheckout(
    path: string,
  ): { branch: string; blocker: LandedBlocker } | undefined {
    return this.landedCheckouts.get(path);
  }

  /** Branch list as loaded, newest first (for-each-ref --sort=-committerdate). */
  getBranches(): BranchInfo[] {
    return this.branches;
  }

  /** Branch names that head an open PR. */
  getPrHeads(): ReadonlySet<string> {
    return new Set(this.prsByHead.keys());
  }

  getPullRequestFor(branch: string): RemotePullRequest | undefined {
    return this.prsByHead.get(branch);
  }

  /** Read-only file rows under a PR branch. */
  getPrFileRows(cwd: string, pr: RemotePullRequest): Promise<TreeNode[]> {
    return this.getPrFiles(cwd, pr);
  }

  isLoading(): boolean {
    return this.loading;
  }

  getError(): string | undefined {
    return this.error;
  }

  getRepoCwd(): string | undefined {
    return this.repoCwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Full refresh: local branch list + PR association. */
  refresh(): void {
    void this.loadBranches();
    void this.loadPrs();
    void this.prunePhantomRemotes();
  }

  /** Cheap git-only reload — called on .git activity. */
  refreshLocal(): void {
    void this.loadBranches();
  }

  private async loadBranches(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      this.branches = [];
      this.error = 'No repository folder open';
      this._onDidChangeTreeData.fire();
      return;
    }
    this.repoCwd = cwd;
    try {
      const list = await listBranches(cwd);
      const fp = list
        .map((b) => `${b.name}\0${b.committerDate}\0${b.hasLocalRef}\0${b.hasRemote}`)
        .join('\n');
      this.error = undefined;
      if (fp !== this.branchesFingerprint) {
        this.branchesFingerprint = fp;
        this.branches = list;
        this._onDidChangeTreeData.fire();
        // After the rows are up: landing is a slow question and nothing
        // renders differently until it is answered.
        void this.refreshLanded(cwd);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error = message;
      this.branches = [];
      this.output.appendLine(`Branch list failed: ${message}`);
      this._onDidChangeTreeData.fire();
    }
  }

  private async loadPrs(): Promise<void> {
    if (!isGithubPrIntegrationEnabled()) {
      if (this.prsByHead.size > 0) {
        this.prsByHead.clear();
        this._onDidChangeTreeData.fire();
      }
      return;
    }
    const cwd = this.getRepoCwd();
    if (!cwd) return;
    this.loading = true;
    const t0 = Date.now();
    try {
      const list = await listOpenRemotePullRequests(cwd);
      this.prsByHead = new Map(
        list.filter((pr) => pr.headRefName).map((pr) => [pr.headRefName, pr]),
      );
      this.output.appendLine(
        `Branches panel: ${this.prsByHead.size} open PR(s) associated (${Date.now() - t0}ms)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`PR association failed: ${message}`);
    } finally {
      this.loading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    try {
      if (!element) return this.getRootChildren();
      if (element.kind === 'branch' && element.pr)
        return await this.getPrFiles(element.repoCwd, element.pr);
      return [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [new MessageItem('Error', message, 'error')];
    }
  }

  private getRootChildren(): TreeNode[] {
    const cwd = this.getRepoCwd();
    if (!cwd) return [new MessageItem('No repository folder open')];
    if (this.error)
      return [new MessageItem('Could not list branches', this.error, 'error')];
    if (this.branches.length === 0) {
      return this.loading
        ? [new MessageItem('Loading…', undefined, 'loading~spin')]
        : [new MessageItem('No branches found')];
    }

    const preview = previewBranch();
    const rows: TreeNode[] = [];
    const seen = new Set<string>();
    for (const b of this.branches) {
      if (b.name === preview) continue;
      if (rows.length >= MAX_ROWS) break;
      seen.add(b.name);
      rows.push(
        new BranchItem(
          cwd,
          b.name,
          b.hasLocalRef,
          b.hasRemote,
          b.relativeDate,
          this.worktreeByBranch.get(b.name),
          this.prsByHead.get(b.name),
        ),
      );
    }
    // PR heads with no local/remote ref (e.g. fork PRs)
    for (const [head, pr] of this.prsByHead) {
      if (seen.has(head) || head === preview) continue;
      rows.push(
        new BranchItem(cwd, head, false, false, '', this.worktreeByBranch.get(head), pr),
      );
    }
    const hidden = this.branches.length - Math.min(this.branches.length, MAX_ROWS);
    if (hidden > 0) {
      rows.push(
        new MessageItem(`${hidden} older branch(es) not shown`, 'git branch -a'),
      );
    }
    return rows;
  }

  private async getPrFiles(
    cwd: string,
    pr: RemotePullRequest,
  ): Promise<TreeNode[]> {
    try {
      let cached = this.filesCache.get(pr.number);
      if (!cached) {
        this.output.appendLine(
          `Fetching PR #${pr.number} head for read-only review…`,
        );
        cached = await listRemotePrFiles(cwd, pr);
        this.filesCache.set(pr.number, cached);
      }
      if (cached.files.length === 0)
        return [new MessageItem('No file changes', pr.baseRefName)];
      return cached.files.map(
        (f) => new RemotePrFileItem(cwd, pr, cached!.baseRef, cached!.headRef, f),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`PR #${pr.number} files failed: ${message}`);
      return [new MessageItem('Could not load PR files', message, 'error')];
    }
  }

  /** Branches confirmed landed in the base, for the Landed group. */
  getLanded(): ReadonlySet<string> {
    return this.landed;
  }

  /**
   * Re-probe which branches have landed. Failure leaves the previous
   * answer standing rather than emptying the group — a branch wrongly
   * absent from Landed is invisible crust, which is the state the group exists
   * to fix, and a probe that could not run is not evidence of anything.
   */
  private async refreshLanded(cwd: string): Promise<void> {
    try {
      const scan = await findLandedBranches(cwd, previewBaseRef(), [
        previewBranch(),
      ]);
      const next = new Set(scan.landed.map((b) => b.name));
      const same =
        next.size === this.landed.size &&
        [...next].every((n) => this.landed.has(n));
      if (!same) {
        this.landed = next;
        this._onDidChangeTreeData.fire();
      }
      // Even when the set is unchanged: a checkout that was dirty last tick
      // may be clean now, and the badge has to follow.
      void this.sweepLanded();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Landed scan failed: ${message}`);
    }
  }

  /**
   * Drop remote-tracking refs for branches origin no longer has.
   *
   * On the full refresh only — it is the one that already goes to the
   * network for PRs — and throttled, because a refresh can fire several
   * times in a row while nothing about the remote has changed.
   */
  private async prunePhantomRemotes(): Promise<void> {
    const cwd = this.getRepoCwd();
    if (!cwd || !isPruneRemoteRefsEnabled()) return;
    const now = Date.now();
    if (now - this.lastPruneAt < PRUNE_THROTTLE_MS) return;
    this.lastPruneAt = now;
    try {
      if (!(await hasOrigin(cwd))) return;
      const pruned = await pruneTrackingRefs(cwd);
      if (pruned.length === 0) return;
      this.output.appendLine(
        `Pruned ${pruned.length} stale remote-tracking ref(s): ${pruned.join(', ')}`,
      );
      // The Remote group is built from those refs, so the rows only go
      // away once the list is read again.
      this.refreshLocal();
    } catch (err) {
      // Offline is not an event: the refs stay, the rows stay, and the next
      // refresh tries again.
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Remote prune skipped: ${message}`);
    }
  }

  /**
   * Clear the checkouts of landed branches, and remember the ones that
   * could not be cleared so their rows can say so.
   *
   * Runs off the landed probe rather than on a timer: a checkout becomes
   * reclaimable at the moment its branch is confirmed in the base, and
   * that answer already arrives here.
   */
  private async sweepLanded(): Promise<void> {
    if (this.sweeping || this.landed.size === 0) return;
    this.sweeping = true;
    try {
      const before = describeBlocked(this.landedCheckouts);
      const result = await sweepLandedWorktrees(this.worktrees, this.landed, {
        remove: isAutoRemoveLandedEnabled(),
        // The one non-git fact: a folder somebody has a file open from is
        // not idle, whatever git says about it.
        isOpen: (dir) => hasOpenEditorIn(dir),
        log: (line) => this.output.appendLine(line),
      });
      this.landedCheckouts = result.blocked;
      // Removals reach discovery through the .git watcher; only the badge
      // set is ours to announce.
      if (describeBlocked(result.blocked) !== before)
        this._onDidChangeTreeData.fire();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Landed checkout sweep failed: ${message}`);
    } finally {
      this.sweeping = false;
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}

/** Stable summary of the badge set, to fire the event only on a change. */
function describeBlocked(
  blocked: ReadonlyMap<string, { branch: string; blocker: LandedBlocker }>,
): string {
  return [...blocked.entries()]
    .map(([p, b]) => `${p}\0${b.blocker}`)
    .sort()
    .join('\n');
}

/** Is any open editor showing a file inside `dir`? */
function hasOpenEditorIn(dir: string): boolean {
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      const fsPath = input?.uri?.fsPath;
      return Boolean(fsPath && isPathInside(fsPath, dir));
    }),
  );
}
