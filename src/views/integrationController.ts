import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiscoveredWorktree } from '../discovery/scanner';
import { baseMergeInProgress } from '../git/laneOps';
import {
  abortIntegrationMerge,
  addAppliedLane,
  addCandidateLane,
  alignIntegrationBranchName,
  baseStatusFor,
  dropAppliedLane,
  dropCandidateLane,
  ensureIntegrationPushBlocked,
  fetchIntegrationBase,
  findLandedLanes,
  integrationBaseRef,
  integrationBranch,
  integrationFingerprint,
  isIntegrationAutoRebuildEnabled,
  isLaneBranch,
  listAppliedLanes,
  listCandidateLanes,
  listWipLanes,
  rebuildIntegration,
  setWipLane,
  type RebuildResult,
} from '../git/integration';
import { isPathInside, shouldIgnoreHotFollowPath } from './pathFilters';

/** What the controller needs from its host (the tree provider). */
export interface IntegrationHost {
  readonly output: { appendLine(value: string): void };
  getWorktrees(): DiscoveredWorktree[];
  getSelectedPath(): string | undefined;
  fireTreeData(): void;
  refresh(): void;
  refreshCompare(worktreePath: string): void;
  /** Selection landed on the integration checkout — move it to a real lane. */
  moveSelectionOff(worktreePath: string): void;
}

export interface IntegrationState {
  path: string;
  branch: string;
  lanes: string[];
  candidates: string[];
  wip: string[];
  landed: string[];
  /** Applied lanes whose tips conflict with the base (probed off-tree). */
  conflicts: string[];
  /** Candidates with a paused base merge in their worktree. */
  resolving: string[];
  error?: { code: string; message: string; lane?: string };
}

/**
 * Integration overlay (focus/working) state machine: detection, lane
 * files, auto-rebuild tick, wip-save reactivity, and the rebuild queue.
 * Owns no tree rendering — panels read getState().
 */
export class IntegrationController implements vscode.Disposable {
  private integrationPath: string | undefined;
  private lanes: string[] = [];
  /** Union of the candidates file and applied lanes — rows under Integration. */
  private candidates: string[] = [];
  /** Candidates whose tips are contained in the base (they landed). */
  private landed: string[] = [];
  /** Lanes whose uncommitted edits overlay into rebuilds. */
  private wip: string[] = [];
  /** Applied lanes whose tips conflict with the base right now. */
  private conflicts: string[] = [];
  /** Candidates with a paused base merge in their worktree. */
  private resolving: string[] = [];
  /** Conflict-probe memo (refSha:baseSha) for the lane-vs-base re-probe. */
  private readonly probeMemo = new Map<string, boolean>();
  private error: { code: string; message: string; lane?: string } | undefined;
  private fingerprint: string | undefined;
  private rebuildInFlight = false;
  /** Reason of a rebuild requested while one was in flight — run once after. */
  private rebuildQueued: string | undefined;
  private wipDebounce: NodeJS.Timeout | undefined;
  private lastBaseFetchAt = 0;

  constructor(private readonly host: IntegrationHost) {}

  /** Integration worktree + lanes, if one is checked out. */
  getState(): IntegrationState | undefined {
    if (!this.integrationPath) {
      return undefined;
    }
    return {
      path: this.integrationPath,
      branch: integrationBranch(),
      lanes: this.lanes.slice(),
      candidates: this.candidates.slice(),
      wip: this.wip.slice(),
      landed: this.landed.slice(),
      conflicts: this.conflicts.slice(),
      resolving: this.resolving.slice(),
      error: this.error,
    };
  }

  getPath(): string | undefined {
    return this.integrationPath;
  }

  async refreshState(): Promise<void> {
    const branch = integrationBranch();
    const wt = this.host
      .getWorktrees()
      .find((w) => !w.detached && w.branch === branch);
    if (!wt) {
      if (this.integrationPath) {
        this.host.output.appendLine('Integration worktree gone — overlay off');
      }
      this.integrationPath = undefined;
      this.lanes = [];
      this.candidates = [];
      this.landed = [];
      this.conflicts = [];
      this.resolving = [];
      this.error = undefined;
      this.fingerprint = undefined;
      return;
    }
    if (this.integrationPath !== wt.path) {
      this.error = undefined;
      this.fingerprint = undefined;
      this.host.output.appendLine(`Integration worktree: ${wt.path} (${branch})`);
      // Covers checkouts created by the shell script or by hand too
      ensureIntegrationPushBlocked(wt.path).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.host.output.appendLine(`Push-block config failed: ${message}`);
      });
      // Enabling must not hijack the compare focus: if the selected
      // checkout just became the integration surface, move selection to a
      // real worktree. Explicit clicks on the Integration row still focus it.
      if (this.host.getSelectedPath() === wt.path) {
        this.host.moveSelectionOff(wt.path);
      }
    }
    this.integrationPath = wt.path;
    try {
      this.lanes = await listAppliedLanes(wt.path);
      const candidates = await listCandidateLanes(wt.path);
      // Applied lanes (e.g. from the shell script) always show as candidates
      this.candidates = [...new Set([...candidates, ...this.lanes])].sort();
      this.wip = await listWipLanes(wt.path);
      this.landed = await findLandedLanes(
        wt.path,
        integrationBaseRef(),
        this.candidates,
      );
      // Persistent conflict badge: re-probe applied lanes against the base
      // on every refresh (memoized per tip pair), so 'conflict' and its
      // Resolve action survive window reloads instead of living only in
      // post-rebuild error memory.
      const conflicts: string[] = [];
      for (const lane of this.lanes) {
        if (this.landed.includes(lane)) {
          continue;
        }
        const st = await baseStatusFor(
          wt.path,
          `refs/heads/${lane}`,
          integrationBaseRef(),
          this.probeMemo,
        );
        if (st?.conflicts) {
          conflicts.push(lane);
        }
      }
      this.conflicts = conflicts;
      // Paused base merges in candidate checkouts (started here or in a
      // terminal) — the lane row shows Complete/Abort either way.
      const resolving: string[] = [];
      for (const w of this.host.getWorktrees()) {
        if (
          !w.detached &&
          w.path !== wt.path &&
          this.candidates.includes(w.branch) &&
          (await baseMergeInProgress(w.path))
        ) {
          resolving.push(w.branch);
        }
      }
      this.resolving = resolving;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`Read lanes failed: ${message}`);
      this.lanes = [];
      this.candidates = [];
      this.wip = [];
      this.landed = [];
      this.conflicts = [];
      this.resolving = [];
    }
  }

  /**
   * Wip lanes: a save/create/delete under an opted-in lane's checkout
   * (VS Code events only, per design) re-snapshots and rebuilds.
   */
  scheduleWipRebuildIfUnderWipLane(uri: vscode.Uri): void {
    if (uri.scheme !== 'file' || !this.integrationPath) {
      return;
    }
    const wip = this.wip.filter((l) => this.lanes.includes(l));
    if (wip.length === 0) {
      return;
    }
    const hit = this.host
      .getWorktrees()
      .find(
        (w) =>
          !w.detached &&
          w.path !== this.integrationPath &&
          wip.includes(w.branch) &&
          isPathInside(uri.fsPath, w.path),
      );
    if (!hit || shouldIgnoreHotFollowPath(uri.fsPath, hit.path)) {
      return;
    }
    this.host.output.appendLine(
      `Wip edit under ${hit.branch} (${path.basename(uri.fsPath)}) — rebuild scheduled`,
    );
    if (this.wipDebounce) {
      clearTimeout(this.wipDebounce);
    }
    this.wipDebounce = setTimeout(() => {
      this.wipDebounce = undefined;
      if (this.rebuildInFlight) {
        // Edits landed mid-rebuild — go again once it finishes
        this.scheduleWipRebuildRetry();
        return;
      }
      void this.runRebuild('wip edits');
    }, 1200);
  }

  private scheduleWipRebuildRetry(): void {
    if (this.wipDebounce) {
      return;
    }
    this.wipDebounce = setTimeout(() => {
      this.wipDebounce = undefined;
      if (this.rebuildInFlight) {
        this.scheduleWipRebuildRetry();
        return;
      }
      void this.runRebuild('wip edits (queued)');
    }, 800);
  }

  /** Toggle overlaying a lane's uncommitted edits; rebuild when applied. */
  async setLaneWip(branch: string, enabled: boolean): Promise<RebuildResult> {
    if (!this.integrationPath) {
      return { ok: false, code: 'error', message: 'no integration worktree' };
    }
    await setWipLane(this.integrationPath, branch, enabled);
    await this.refreshState();
    this.host.fireTreeData();
    if (this.lanes.includes(branch)) {
      return this.runRebuild(enabled ? `wip on ${branch}` : `wip off ${branch}`);
    }
    return { ok: true, lanes: this.lanes.slice(), skipped: [], landed: [] };
  }

  /**
   * Auto-rebuild: rebuild the integration tree when the base or an applied
   * lane tip moves (commit/amend/rebase anywhere — no git hook needed).
   */
  async tick(): Promise<void> {
    if (!this.integrationPath || this.rebuildInFlight) {
      return;
    }
    if (!isIntegrationAutoRebuildEnabled()) {
      this.fingerprint = undefined;
      return;
    }
    // Track where PRs actually land: refresh origin/<base> periodically.
    // A moved tip changes the fingerprint below and triggers the rebuild.
    const fetchMs = vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<number>('integrationFetchIntervalMs', 300000);
    if (fetchMs > 0 && Date.now() - this.lastBaseFetchAt > fetchMs) {
      this.lastBaseFetchAt = Date.now();
      // Fire-and-forget: never let a slow/hung remote stall the tick. A
      // moved tip is picked up by the fingerprint on the next tick.
      void fetchIntegrationBase(this.integrationPath, integrationBaseRef())
        .then((ok) =>
          this.host.output.appendLine(
            ok
              ? `Fetched origin ${integrationBaseRef()} (integration base)`
              : 'Integration base fetch failed (offline / no remote?)',
          ),
        )
        .catch(() => {});
    }
    // Conflicts no longer dirty the checkout (off-tree merge), so keep
    // retrying — a new commit on the conflicting lane may resolve it.
    let fp: string;
    try {
      fp = await integrationFingerprint(
        this.integrationPath,
        integrationBaseRef(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`Integration fingerprint failed: ${message}`);
      return;
    }
    if (this.fingerprint === undefined) {
      this.fingerprint = fp;
      return;
    }
    if (fp === this.fingerprint) {
      return;
    }
    this.fingerprint = fp;
    await this.runRebuild('lane tips moved');
  }

  /**
   * Base changed: the templated branch name may change with it — rename
   * the checkout's branch to match, then rebuild onto the new base.
   */
  async handleBaseChange(): Promise<void> {
    if (!this.integrationPath) {
      this.host.fireTreeData();
      return;
    }
    try {
      const renamed = await alignIntegrationBranchName(this.integrationPath);
      if (renamed) {
        this.host.output.appendLine(
          `Integration branch renamed: ${renamed.from} → ${renamed.to}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`Integration branch rename failed: ${message}`);
    }
    await this.runRebuild('base changed');
    this.host.refresh();
  }

  /** Run a rebuild and surface the outcome on the integration row. */
  async runRebuild(reason: string): Promise<RebuildResult> {
    const workingPath = this.integrationPath;
    if (!workingPath) {
      return { ok: false, code: 'error', message: 'no integration worktree' };
    }
    if (this.rebuildInFlight) {
      // Never drop intent (e.g. unchecking a lane mid-rebuild): queue one
      // follow-up run — it re-reads the lane files, so it applies whatever
      // state the caller just wrote.
      this.rebuildQueued = reason;
      return { ok: false, code: 'busy', message: 'rebuild already running' };
    }
    this.rebuildInFlight = true;
    const t0 = Date.now();
    try {
      if (reason === 'manual') {
        // Manual rebuild = "give me reality": refresh the base tip first
        this.lastBaseFetchAt = Date.now();
        await fetchIntegrationBase(workingPath, integrationBaseRef());
      }
      const result = await rebuildIntegration(workingPath, integrationBaseRef());
      if (result.ok) {
        this.error = undefined;
        // Landed lanes were retired by the rebuild itself (under its lock);
        // rows stay as candidates with the 'landed' tag
        for (const lane of result.landed) {
          this.host.output.appendLine(
            `Lane ${lane} landed in ${integrationBaseRef()} — unapplied`,
          );
        }
        this.host.output.appendLine(
          `Integration rebuilt (${reason}): ${
            result.lanes.length > 0 ? result.lanes.join(', ') : 'base only'
          }${
            result.skipped.length > 0
              ? ` · skipped missing: ${result.skipped.join(', ')}`
              : ''
          } (${Date.now() - t0}ms)`,
        );
      } else if (result.code === 'busy') {
        // Script/hook holds the lock — not an error state for the row
        this.host.output.appendLine(`Integration rebuild busy (${reason})`);
      } else {
        this.error = {
          code: result.code,
          message: result.message,
          lane: result.lane,
        };
        this.host.output.appendLine(
          `Integration rebuild failed (${reason}, ${result.code}${
            result.lane ? `, lane ${result.lane}` : ''
          }): ${result.message}`,
        );
      }
      await this.refreshState();
      this.host.refreshCompare(workingPath);
      this.host.fireTreeData();
      return result;
    } finally {
      this.rebuildInFlight = false;
      if (this.rebuildQueued) {
        const queued = this.rebuildQueued;
        this.rebuildQueued = undefined;
        void this.runRebuild(`${queued} (queued)`);
      }
    }
  }

  /** Offer a branch under the Integration row (unchecked; no rebuild). */
  async addCandidate(branch: string): Promise<void> {
    if (!this.integrationPath) {
      return;
    }
    if (!isLaneBranch(branch, integrationBaseRef())) {
      throw new Error(`${branch} cannot be an integration lane`);
    }
    await addCandidateLane(this.integrationPath, branch);
    await this.refreshState();
    this.host.fireTreeData();
  }

  /** Drop a branch from the Integration row; rebuild if it was applied. */
  async removeCandidate(branch: string): Promise<RebuildResult> {
    if (!this.integrationPath) {
      return { ok: false, code: 'error', message: 'no integration worktree' };
    }
    await dropCandidateLane(this.integrationPath, branch);
    if (this.lanes.includes(branch)) {
      return this.hide(branch);
    }
    await this.refreshState();
    this.host.fireTreeData();
    return { ok: true, lanes: this.lanes.slice(), skipped: [], landed: [] };
  }

  /** Add this branch as a lane and rebuild. */
  async apply(branch: string): Promise<RebuildResult> {
    if (!this.integrationPath) {
      return { ok: false, code: 'error', message: 'no integration worktree' };
    }
    if (!isLaneBranch(branch, integrationBaseRef())) {
      return {
        ok: false,
        code: 'error',
        message: `will not apply ${branch} as a lane`,
      };
    }
    // Persist candidacy too, so unchecking later keeps the row visible
    await addCandidateLane(this.integrationPath, branch);
    await addAppliedLane(this.integrationPath, branch);
    return this.runRebuild(`apply ${branch}`);
  }

  /** Drop this branch from the lanes and rebuild. */
  async hide(branch: string): Promise<RebuildResult> {
    if (!this.integrationPath) {
      return { ok: false, code: 'error', message: 'no integration worktree' };
    }
    await dropAppliedLane(this.integrationPath, branch);
    return this.runRebuild(`hide ${branch}`);
  }

  /** Abort a conflicted lane merge, leaving the tree at the last good state. */
  async abortMerge(): Promise<void> {
    if (!this.integrationPath) {
      return;
    }
    await abortIntegrationMerge(this.integrationPath);
    this.error = undefined;
    this.fingerprint = undefined;
    this.host.refreshCompare(this.integrationPath);
    this.host.fireTreeData();
  }

  dispose(): void {
    if (this.wipDebounce) {
      clearTimeout(this.wipDebounce);
      this.wipDebounce = undefined;
    }
  }
}
