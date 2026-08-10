import * as vscode from 'vscode';
import {
  isGithubPrIntegrationEnabled,
  resetGithubPrClient,
} from '../github/pr';
import {
  listOpenRemotePullRequests,
  listRemotePrFiles,
  type RemotePullRequest,
} from '../github/remotePrs';
import type { FileChange } from '../git/compare';
import {
  MessageItem,
  RemotePrFileItem,
  RemotePrItem,
  type TreeNode,
} from './nodes';

/**
 * Standalone tree: open PRs without a local worktree.
 * Read-only file review + create worktree via context menu.
 */
export class RemotePrsTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private remotePrs: RemotePullRequest[] = [];
  private loading = false;
  private error: string | undefined;
  private repoCwd: string | undefined;
  private readonly filesCache = new Map<
    number,
    { baseRef: string; headRef: string; files: FileChange[] }
  >();
  private readonly disposables: vscode.Disposable[] = [];
  /** Branches currently checked out in local worktrees (hide matching PRs). */
  private localBranches = new Set<string>();

  constructor(private readonly output: { appendLine(value: string): void }) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('worktreeCompare.githubPullRequests') ||
          e.affectsConfiguration('worktreeCompare.remotePrLimit')
        ) {
          resetGithubPrClient();
          this.filesCache.clear();
          void this.refresh();
        }
      }),
    );
    void this.refresh();
  }

  /** Call when worktree list changes so we hide PRs that already have trees. */
  setLocalBranches(branches: Iterable<string>): void {
    this.localBranches = new Set(branches);
    // Re-filter without full network if we already have a list
    if (this.remotePrs.length > 0 || this.error) {
      void this.refresh();
    }
  }

  getRepoCwd(): string | undefined {
    return (
      this.repoCwd ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );
  }

  getRemotePr(prNumber: number): RemotePullRequest | undefined {
    return this.remotePrs.find((p) => p.number === prNumber);
  }

  refresh(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    if (!isGithubPrIntegrationEnabled()) {
      this.remotePrs = [];
      this.error = undefined;
      this.loading = false;
      this._onDidChangeTreeData.fire();
      return;
    }
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      this.remotePrs = [];
      this.error = 'No repository folder open';
      this.loading = false;
      this._onDidChangeTreeData.fire();
      return;
    }

    this.loading = true;
    this.error = undefined;
    this.repoCwd = cwd;
    this._onDidChangeTreeData.fire();
    const t0 = Date.now();
    try {
      const list = await listOpenRemotePullRequests(cwd);
      const withoutLocal = list.filter(
        (pr) => !(pr.headRefName && this.localBranches.has(pr.headRefName)),
      );
      this.remotePrs = withoutLocal.map((pr) => ({
        ...pr,
        hasLocalWorktree: false,
      }));
      const hidden = list.length - withoutLocal.length;
      this.output.appendLine(
        `Remote PRs panel: ${this.remotePrs.length} open without local worktree` +
          (hidden > 0 ? ` (hid ${hidden} already local)` : '') +
          ` (${Date.now() - t0}ms)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error = message;
      this.remotePrs = [];
      this.output.appendLine(`Remote PRs list failed: ${message}`);
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
      if (element.kind === 'remotePr') {
        return await this.getPrFiles(element);
      }
      return [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [new MessageItem('Error', message, 'error')];
    }
  }

  private getRootChildren(): TreeNode[] {
    if (!isGithubPrIntegrationEnabled()) {
      return [
        new MessageItem(
          'GitHub integration off',
          'worktreeCompare.githubPullRequests',
        ),
      ];
    }
    if (this.loading && this.remotePrs.length === 0) {
      return [
        new MessageItem('Loading pull requests…', undefined, 'loading~spin'),
      ];
    }
    if (this.error) {
      return [new MessageItem('Could not list PRs', this.error, 'error')];
    }
    const cwd = this.getRepoCwd();
    if (!cwd) {
      return [new MessageItem('No repository folder open')];
    }
    if (this.remotePrs.length === 0) {
      return [
        new MessageItem(
          'No open PRs without a local worktree',
          'Create a worktree from a PR, or open ones already listed under Worktree',
        ),
      ];
    }
    return this.remotePrs.map((pr) => new RemotePrItem(pr, cwd));
  }

  private async getPrFiles(item: RemotePrItem): Promise<TreeNode[]> {
    const cwd = item.repoCwd;
    try {
      let cached = this.filesCache.get(item.pr.number);
      if (!cached) {
        this.output.appendLine(
          `Fetching PR #${item.pr.number} head for read-only review…`,
        );
        cached = await listRemotePrFiles(cwd, item.pr);
        this.filesCache.set(item.pr.number, cached);
        this.output.appendLine(
          `PR #${item.pr.number}: ${cached.files.length} file(s) (${cached.baseRef}...${cached.headRef})`,
        );
      }
      if (cached.files.length === 0) {
        return [new MessageItem('No file changes', item.pr.baseRefName)];
      }
      return cached.files.map(
        (f) =>
          new RemotePrFileItem(
            cwd,
            item.pr,
            cached!.baseRef,
            cached!.headRef,
            f,
          ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(
        `Remote PR #${item.pr.number} files failed: ${message}`,
      );
      return [new MessageItem('Could not load PR files', message, 'error')];
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
