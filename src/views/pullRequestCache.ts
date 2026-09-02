import type { DiscoveredWorktree } from '../git/discovery';
import { isGithubPrIntegrationEnabled, type PullRequestInfo } from '../github/pr';
import type { PullRequestIndex } from '../github/prIndex';

/** One entry per checkout, keyed by path + branch. */
function key(worktreePath: string, branch: string): string {
  return `${worktreePath}\0${branch}`;
}

/**
 * The PR (if any) behind each checkout, remembered between renders.
 *
 * Rows are rebuilt on every tree refresh, so the answer has to be
 * remembered or the panel would look one up per row per keystroke. A miss
 * and a known "no PR" are stored distinctly (`null`), because re-asking for
 * branches that have no PR was most of the old cost.
 *
 * It no longer asks per branch. One repo-wide query in PullRequestIndex
 * answers every checkout at once — see there for why that is the whole
 * point — and this class is the projection of that answer onto the rows,
 * which is a map lookup and no network at all.
 *
 * Refreshes are GENERATIONAL: a refresh that starts while another is in
 * flight abandons the older one rather than letting two runs interleave
 * writes. Whoever asked last is the one who wants an answer.
 */
export class PullRequestCache {
  private readonly entries = new Map<string, PullRequestInfo | null>();
  private generation = 0;

  constructor(
    private readonly output: { appendLine(value: string): void },
    /** Rows carry PR state, so a changed cache means a changed tree. */
    private readonly onChange: () => void,
    private readonly index: PullRequestIndex,
  ) {}

  get(worktreePath: string, branch: string): PullRequestInfo | undefined {
    return this.entries.get(key(worktreePath, branch)) ?? undefined;
  }

  /** Drop everything so the next refresh re-queries GitHub. */
  clear(): void {
    this.entries.clear();
    this.index.clear();
  }

  /**
   * Re-associate each checkout with its PR. `force` is an explicit user
   * refresh — it goes to the network even inside the query window.
   */
  async refresh(
    worktrees: DiscoveredWorktree[],
    repoCwd: string | undefined,
    force = false,
  ): Promise<void> {
    if (!isGithubPrIntegrationEnabled()) {
      if (this.entries.size > 0) {
        this.entries.clear();
        this.onChange();
      }
      return;
    }
    if (worktrees.length === 0 || !repoCwd) return;
    const generation = ++this.generation;
    try {
      await this.index.ensureOpen(repoCwd, force);
      if (generation !== this.generation) return;

      // A pushed branch with no open PR may have landed — that is the only
      // case worth a second query, and only for branches that could have
      // one. A local-only branch has never been on GitHub, so no answer
      // about it exists to fetch.
      const missing = worktrees.filter(
        (wt) =>
          !wt.detached &&
          wt.branch &&
          wt.branch !== 'HEAD' &&
          wt.publishState !== 'local' &&
          !this.index.openByHead.has(wt.branch),
      );
      if (missing.length > 0) {
        await this.index.ensureClosed(repoCwd, force);
        if (generation !== this.generation) return;
      }

      let found = 0;
      for (const wt of worktrees) {
        if (wt.detached || !wt.branch || wt.branch === 'HEAD') continue;
        const pr = this.index.get(wt.branch);
        this.entries.set(key(wt.path, wt.branch), pr ?? null);
        if (pr) found += 1;
      }
      this.output.appendLine(
        `GitHub PR lookup: ${found}/${worktrees.length} branch(es) have a PR`,
      );
      this.onChange();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`GitHub PR lookup failed: ${message}`);
    }
  }

  /** Forget worktrees / branches that no longer exist. */
  prune(worktrees: DiscoveredWorktree[]): void {
    if (this.entries.size === 0) return;
    const live = new Set(worktrees.map((wt) => key(wt.path, wt.branch)));
    for (const k of [...this.entries.keys()])
      if (!live.has(k)) this.entries.delete(k);
  }
}
