import * as vscode from 'vscode';
import { listBranches, type BranchInfo } from '../git/branches';
import type { FileChange } from '../git/compare';
import { integrationBaseRef, integrationBranch } from '../git/integration';
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
import type { DiscoveredWorktree } from '../discovery/scanner';
import { BranchItem, MessageItem, RemotePrFileItem, type TreeNode } from './nodes';

const MAX_ROWS = 50;

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
  private prsByHead = new Map<string, RemotePullRequest>();
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
    this.worktreeByBranch = new Map(
      worktrees.filter((w) => !w.detached).map((w) => [w.branch, w.path]),
    );
    this._onDidChangeTreeData.fire();
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
    if (!cwd) {
      return;
    }
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
      if (!element) {
        return this.getRootChildren();
      }
      if (element.kind === 'branch' && element.pr) {
        return await this.getPrFiles(element.repoCwd, element.pr);
      }
      return [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [new MessageItem('Error', message, 'error')];
    }
  }

  private getRootChildren(): TreeNode[] {
    const cwd = this.getRepoCwd();
    if (!cwd) {
      return [new MessageItem('No repository folder open')];
    }
    if (this.error) {
      return [new MessageItem('Could not list branches', this.error, 'error')];
    }
    if (this.branches.length === 0) {
      return this.loading
        ? [new MessageItem('Loading…', undefined, 'loading~spin')]
        : [new MessageItem('No branches found')];
    }

    const integration = integrationBranch();
    const rows: TreeNode[] = [];
    const seen = new Set<string>();
    for (const b of this.branches) {
      if (b.name === integration) {
        continue;
      }
      if (rows.length >= MAX_ROWS) {
        break;
      }
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
      if (seen.has(head) || head === integration) {
        continue;
      }
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
      if (cached.files.length === 0) {
        return [new MessageItem('No file changes', pr.baseRefName)];
      }
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
      const scan = await findLandedBranches(cwd, integrationBaseRef(), [
        integrationBranch(),
      ]);
      const next = new Set(scan.landed.map((b) => b.name));
      const same =
        next.size === this.landed.size &&
        [...next].every((n) => this.landed.has(n));
      if (!same) {
        this.landed = next;
        this._onDidChangeTreeData.fire();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Landed scan failed: ${message}`);
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
