import * as vscode from 'vscode';
import { createGhJson, isGhAvailable, type GhJson } from './gh';
import { isGithubPrIntegrationEnabled, type PullRequestInfo } from './pr';

/** Open PR listed for remote review (may not have a local worktree). */
export interface RemotePullRequest extends PullRequestInfo {
  authorLogin?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** Local worktree already has this head branch checked out */
  hasLocalWorktree?: boolean;
}

/**
 * One field list, because there is one query.
 *
 * The union of what any panel wants is barely more expensive than what the
 * cheapest one wants, and asking twice for different subsets was the shape
 * that made a repo-wide answer look impossible.
 */
const PR_FIELDS =
  'number,title,state,url,isDraft,headRefName,baseRefName,author,additions,deletions,changedFiles,mergeable,mergeStateStatus';

/** Closed/merged PRs answer a question about history — they go stale slowly. */
const CLOSED_TTL_FLOOR_MS = 15 * 60_000;

interface GhPrRow {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
  author?: { login?: string };
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergeable?: string;
  mergeStateStatus?: string;
}

function normalize(row: GhPrRow): RemotePullRequest | undefined {
  if (typeof row.number !== 'number' || !row.url || !row.title || !row.state)
    return undefined;
  const stateRaw = row.state.toUpperCase();
  const state: PullRequestInfo['state'] =
    stateRaw === 'MERGED' ? 'merged' : stateRaw === 'CLOSED' ? 'closed' : 'open';
  const mergeable = row.mergeable?.toUpperCase();
  return {
    number: row.number,
    title: row.title,
    state,
    isDraft: Boolean(row.isDraft),
    url: row.url,
    headRefName: row.headRefName ?? '',
    baseRefName: row.baseRefName,
    authorLogin: row.author?.login,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changedFiles,
    mergeable:
      mergeable === 'MERGEABLE' ||
      mergeable === 'CONFLICTING' ||
      mergeable === 'UNKNOWN'
        ? mergeable
        : undefined,
    mergeStateStatus: row.mergeStateStatus?.toUpperCase(),
  };
}

/** Max PRs fetched per list query. */
function prLimit(): number {
  const n = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<number>('remotePrLimit', 30);
  return Math.max(1, Math.min(100, n || 30));
}

/** Least time between repo-wide PR queries. */
function refreshMs(): number {
  const n = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<number>('githubPrRefreshMs', 120_000);
  return Math.max(0, n ?? 120_000);
}

/** Nobody is looking at an unfocused window; the answer can wait for them. */
function windowFocused(): boolean {
  return vscode.window?.state?.focused ?? true;
}

/**
 * Every pull request of the repo, asked for ONCE and read by every panel.
 *
 * The cost this class exists to remove is not the subprocess, it is the
 * request: `gh pr list --head <branch>` is one GitHub API call, and asking
 * it per branch per refresh — plus a second call for branches with no open
 * PR, plus a `pr view` to fill in mergeability — made a repo with eight
 * lanes spend ~20 requests every time a file appeared under `.worktrees`.
 * At a few refreshes a minute that is the whole hourly budget, which is
 * shared with the user's own `gh`.
 *
 * A repo-wide list answers every branch at once, so the cost is per REPO
 * per window rather than per branch per refresh — two queries at most, and
 * the second only when some branch was not in the first.
 *
 * Three rules keep it honest:
 * - A window (`githubPrRefreshMs`) caps how often it asks. Refreshes fire
 *   in bursts and from events that cannot have changed a PR; they read the
 *   remembered answer.
 * - Concurrent callers share one in-flight query rather than racing.
 * - Nothing is asked while the window is unfocused, or while the API is in
 *   rate-limit cooldown. A stale badge is better than a spent budget, and
 *   an explicit refresh (`force`) is how a user says otherwise.
 */
export class PullRequestIndex {
  private readonly open = new Map<string, RemotePullRequest>();
  private readonly closed = new Map<string, RemotePullRequest>();
  private openFetchedAt = 0;
  private closedFetchedAt = 0;
  private openInFlight: Promise<void> | undefined;
  private closedInFlight: Promise<void> | undefined;
  private readonly ghJson: GhJson;

  private readonly ghPresent: () => Promise<boolean>;
  private readonly now: () => number;

  constructor(
    private readonly output: { appendLine(value: string): void },
    /** Seams for tests; production shells out to `gh` and reads the clock. */
    seams: {
      ghJson?: GhJson;
      ghPresent?: () => Promise<boolean>;
      now?: () => number;
    } = {},
  ) {
    this.ghJson = seams.ghJson ?? createGhJson(output);
    this.ghPresent = seams.ghPresent ?? isGhAvailable;
    this.now = seams.now ?? Date.now;
  }

  /** Open PRs by head branch, newest answer held. */
  get openByHead(): ReadonlyMap<string, RemotePullRequest> {
    return this.open;
  }

  /** The PR behind a head branch — open if there is one, else closed/merged. */
  get(headRefName: string): RemotePullRequest | undefined {
    return this.open.get(headRefName) ?? this.closed.get(headRefName);
  }

  /** Drop everything so the next ask goes to the network. */
  clear(): void {
    this.open.clear();
    this.closed.clear();
    this.openFetchedAt = 0;
    this.closedFetchedAt = 0;
  }

  /**
   * Make sure the open-PR list is current enough to answer with.
   * Resolves without asking when the window has not lapsed.
   */
  async ensureOpen(repoCwd: string, force = false): Promise<void> {
    if (this.openInFlight) return this.openInFlight;
    if (!this.shouldFetch(this.openFetchedAt, refreshMs(), force)) return;
    this.openInFlight = this.fetch(
      repoCwd,
      'open',
      this.open,
      (at) => (this.openFetchedAt = at),
    ).finally(() => {
      this.openInFlight = undefined;
    });
    return this.openInFlight;
  }

  /**
   * Also learn the closed/merged PRs, so a landed branch still shows how it
   * landed. Its own, longer window: this answer is about history, and the
   * branches asking for it are the ones that stopped changing.
   */
  async ensureClosed(repoCwd: string, force = false): Promise<void> {
    if (this.closedInFlight) return this.closedInFlight;
    const ttl = Math.max(CLOSED_TTL_FLOOR_MS, refreshMs());
    if (!this.shouldFetch(this.closedFetchedAt, ttl, force)) return;
    this.closedInFlight = this.fetch(
      repoCwd,
      'closed',
      this.closed,
      (at) => (this.closedFetchedAt = at),
    ).finally(() => {
      this.closedInFlight = undefined;
    });
    return this.closedInFlight;
  }

  private shouldFetch(fetchedAt: number, ttlMs: number, force: boolean): boolean {
    if (force) return true;
    // Never asked: answer once even unfocused, so a window opened in the
    // background is not blank when it is looked at.
    if (fetchedAt === 0) return true;
    if (!windowFocused()) return false;
    return this.now() - fetchedAt >= ttlMs;
  }

  private async fetch(
    repoCwd: string,
    state: 'open' | 'closed',
    into: Map<string, RemotePullRequest>,
    stamp: (at: number) => void,
  ): Promise<void> {
    if (!isGithubPrIntegrationEnabled() || !(await this.ghPresent())) return;
    const t0 = this.now();
    const rows = await this.ghJson<GhPrRow[]>(repoCwd, [
      'pr',
      'list',
      '--state',
      state,
      '--limit',
      String(prLimit()),
      '--json',
      PR_FIELDS,
    ]);
    // A failed or refused query leaves the last answer standing: badges do
    // not blink out because the network did, and the window still closes so
    // a broken remote is not retried on every refresh.
    stamp(this.now());
    if (!rows) return;
    into.clear();
    for (const row of rows) {
      const pr = normalize(row);
      if (pr?.headRefName) into.set(pr.headRefName, pr);
    }
    this.output.appendLine(
      `GitHub: ${into.size} ${state} PR(s) in one query (${this.now() - t0}ms)`,
    );
  }
}
