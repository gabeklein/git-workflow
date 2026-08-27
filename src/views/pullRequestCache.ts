import type { DiscoveredWorktree } from '../git/discovery';
import {
  findPullRequestForBranch,
  isGithubPrIntegrationEnabled,
  type PullRequestInfo,
} from '../github/pr';

/** One entry per checkout, keyed by path + branch. */
function key(worktreePath: string, branch: string): string {
  return `${worktreePath}\0${branch}`;
}

/**
 * The PR (if any) behind each checkout, remembered between renders.
 *
 * Every lookup is a `gh` subprocess against the network, and rows are
 * rebuilt on every tree refresh — so the answer has to be cached or the
 * panel would spawn a process per row per keystroke. A miss and a known
 * "no PR" are stored distinctly (`null`), because re-asking for branches
 * that have no PR is most of the cost.
 *
 * Refreshes are GENERATIONAL: a refresh that starts while another is in
 * flight abandons the older one mid-queue rather than letting two runs
 * interleave writes. Whoever asked last is the one who wants an answer.
 */
export class PullRequestCache {
  private readonly entries = new Map<string, PullRequestInfo | null>();
  private generation = 0;

  constructor(
    private readonly output: { appendLine(value: string): void },
    /** Rows carry PR state, so a changed cache means a changed tree. */
    private readonly onChange: () => void,
  ) {}

  get(worktreePath: string, branch: string): PullRequestInfo | undefined {
    return this.entries.get(key(worktreePath, branch)) ?? undefined;
  }

  /** Drop everything so the next refresh re-queries `gh`. */
  clear(): void {
    this.entries.clear();
  }

  /** Re-query GitHub (via `gh`) for PRs associated with each branch. */
  async refresh(worktrees: DiscoveredWorktree[]): Promise<void> {
    if (!isGithubPrIntegrationEnabled()) {
      if (this.entries.size > 0) {
        this.entries.clear();
        this.onChange();
      }
      return;
    }
    if (worktrees.length === 0) return;
    const generation = ++this.generation;
    const t0 = Date.now();
    let found = 0;
    try {
      // Bounded concurrency so many worktrees don't spawn a gh storm
      const queue = worktrees.slice();
      const workers = Array.from(
        { length: Math.min(3, queue.length) },
        async () => {
          while (queue.length > 0) {
            if (generation !== this.generation) return;
            const wt = queue.shift();
            if (!wt) return;
            try {
              const pr = await findPullRequestForBranch(
                wt.path,
                wt.branch,
                wt.detached,
              );
              if (generation !== this.generation) return;
              this.entries.set(key(wt.path, wt.branch), pr ?? null);
              if (pr) found += 1;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              this.output.appendLine(
                `PR lookup failed for ${wt.branch}: ${message}`,
              );
              this.entries.set(key(wt.path, wt.branch), null);
            }
          }
        },
      );
      await Promise.all(workers);
      if (generation !== this.generation) return;
      this.output.appendLine(
        `GitHub PR lookup: ${found}/${worktrees.length} branch(es) have a PR (${Date.now() - t0}ms)`,
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
