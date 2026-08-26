import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiscoveredWorktree } from '../discovery/scanner';
import { git, gitOk } from '../git/exec';
import { revParseCommit } from '../git/plumbing';
import { baseMergeInProgress, fastForwardEmptyLane } from '../git/laneOps';
import {
  absorbDirtyEdits,
  absorbStrayCommits,
  addedPathsInCommits,
  checkoutForBranch,
  clearBasePin,
  readBasePin,
  resolveBaseSha,
  writeBasePin,
  abortIntegrationMerge,
  addAppliedLane,
  addCandidateLane,
  addExcludedLane,
  alignIntegrationBranchName,
  installCommitGuard,
  isCommitGuardEnabled,
  uninstallCommitGuard,
  baseStatusFor,
  dropAppliedLane,
  dropCandidateLane,
  ensureIntegrationPushBlocked,
  fetchIntegrationBase,
  findLandedLanes,
  findStrayCommits,
  integrationBaseRef,
  integrationBranch,
  integrationFingerprint,
  isIntegrationAutoRebuildEnabled,
  isIntegrationAbsorbEnabled,
  isLaneBranch,
  laneNeverDiverged,
  listAppliedLanes,
  dropExcludedLane,
  listCandidateLanes,
  listExcludedLanes,
  listWipLanes,
  pruneDeadLanes,
  rebuildIntegration,
  setWipLane,
  type AbsorbResult,
  type AbsorbTarget,
  type RebuildResult,
  type ResolvedLane,
} from '../git/integration';
import { isPathInside, shouldIgnoreHotFollowPath } from './pathFilters';

/** What the controller needs from its host (the tree provider). */
export interface IntegrationHost {
  readonly output: { appendLine(value: string): void };
  getWorktrees(): DiscoveredWorktree[];
  getRepoCwd(): string | undefined;
  getSelectedPath(): string | undefined;
  fireTreeData(): void;
  refresh(): void;
  refreshCompare(worktreePath: string): void;
  /** Selection landed on the integration checkout — move it to a real lane. */
  moveSelectionOff(worktreePath: string): void;
  /** Override ?? genuine inference for a worktree's base — undefined when
   *  there is no evidence (auto-membership must never enroll on a guess). */
  genuineBaseFor(worktreePath: string): Promise<string | undefined>;
}

export interface IntegrationState {
  path: string;
  branch: string;
  lanes: string[];
  candidates: string[];
  /** Explicitly-added candidates (focus-candidates file); the rest of the
   *  candidates are auto members (base matches) or script-applied lanes. */
  explicit: string[];
  wip: string[];
  landed: string[];
  /** Applied lanes whose tips conflict with the base (probed off-tree). */
  conflicts: string[];
  /** Candidates with a paused base merge in their worktree. */
  resolving: string[];
  /** Lanes whose conflicts the last rebuild's resolver settled. */
  autoResolved: ResolvedLane[];
  /** Local <base> carries commits the frozen base does not — offer
   *  Convert-to-Branch / Catch Up instead of silently retargeting. */
  baseDrift?: { ahead: number; sha: string; resetTo: string; included: boolean };
  /** A git merge is paused in the integration checkout itself (external
   *  script / by hand) — Abort Integration Merge only applies then. */
  mergePaused: boolean;
  error?: { code: string; message: string; lane?: string };
}

/**
 * Integration overlay (focus/working) state machine: detection, lane
 * files, auto-rebuild tick, wip-save reactivity, and the rebuild queue.
 * Owns no tree rendering — panels read getState().
 */
export class IntegrationController implements vscode.Disposable {
  private integrationPath: string | undefined;
  /** Path:branch:enabled the pre-commit guard was last reconciled for. */
  private guardSyncedFor: string | undefined;
  private lanes: string[] = [];
  /** Everything shown under Integration: explicit + applied + auto members. */
  private candidates: string[] = [];
  /** Explicitly-added candidates (focus-candidates file). */
  private explicit: string[] = [];
  /** Candidates whose tips are contained in the base (they landed). */
  private landed: string[] = [];
  /** Lanes whose uncommitted edits overlay into rebuilds. */
  private wip: string[] = [];
  /** Applied lanes whose tips conflict with the base right now. */
  private conflicts: string[] = [];
  /** Candidates with a paused base merge in their worktree. */
  private resolving: string[] = [];
  private mergePaused = false;
  /** Resolver outcomes from the last successful rebuild. */
  private autoResolved: ResolvedLane[] = [];
  private baseDrift:
    | { ahead: number; sha: string; resetTo: string; included: boolean }
    | undefined;
  /** Conflict-probe memo (refSha:baseSha) for the lane-vs-base re-probe. */
  private readonly probeMemo = new Map<string, boolean>();
  private error: { code: string; message: string; lane?: string } | undefined;
  private fingerprint: string | undefined;
  private rebuildInFlight = false;
  /** Reason of a rebuild requested while one was in flight — run once after. */
  private rebuildQueued: string | undefined;
  private wipDebounce: NodeJS.Timeout | undefined;
  /** Integration HEAD of the last auto-absorb attempt — one try per tip,
   *  so a target that keeps refusing never loops the rebuild queue. */
  private lastAbsorbHead: string | undefined;
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
      explicit: this.explicit.slice(),
      wip: this.wip.slice(),
      landed: this.landed.slice(),
      conflicts: this.conflicts.slice(),
      resolving: this.resolving.slice(),
      autoResolved: this.autoResolved.slice(),
      baseDrift: this.baseDrift,
      mergePaused: this.mergePaused,
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
      if (this.guardSyncedFor) {
        this.guardSyncedFor = undefined;
        void this.syncCommitGuard(undefined, branch);
      }
      this.integrationPath = undefined;
      this.lanes = [];
      this.candidates = [];
      this.explicit = [];
      this.landed = [];
      this.conflicts = [];
      this.resolving = [];
      this.autoResolved = [];
      this.baseDrift = undefined;
      this.mergePaused = false;
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
    const guardKey = `${wt.path}:${branch}:${isCommitGuardEnabled()}`;
    if (this.guardSyncedFor !== guardKey) {
      this.guardSyncedFor = guardKey;
      void this.syncCommitGuard(wt.path, branch);
    }
    try {
      // Dead lanes: a branch deleted out from under Integration (its
      // worktree died — landed and cleaned up, agent teardown) leaves
      // ghost rows in the lane files. Prune before reading, so a lane
      // that no longer exists never renders or re-enters a rebuild.
      const pruned = await pruneDeadLanes(wt.path);
      if (pruned.length > 0) {
        this.host.output.appendLine(
          `Integration lanes pruned (branch gone): ${pruned.join(', ')}`,
        );
      }
      // Freeze the base on first sight of this integration checkout: the
      // pin is what rebuilds anchor to; only published (origin) movement
      // or an explicit Catch Up advances it. Enable/base-change clear it,
      // so it re-pins fresh; reloads keep it — that IS the freeze.
      if (!(await readBasePin(wt.path))) {
        // Pin at the PUBLISHED tip when one exists: if local <base> is
        // already ahead at first sight (commits made before integration
        // loaded), that segment is drift to SURFACE as a lane — not floor
        // to swallow. The descendant-preferring legacy resolution would
        // pin the drifted tip and hide it forever. No origin → local.
        const initName = integrationBaseRef().replace(/^origin\//, '');
        const fresh =
          (await revParseCommit(wt.path, `origin/${initName}`)) ??
          (await revParseCommit(wt.path, `refs/heads/${initName}`)) ??
          (await resolveBaseSha(wt.path, integrationBaseRef()));
        if (fresh) {
          await writeBasePin(wt.path, fresh);
          this.host.output.appendLine(
            `Integration base pinned at ${fresh.slice(0, 10)} (${integrationBaseRef()})`,
          );
        }
      }
      // Drift: local <base> carries commits the frozen base does not —
      // the panel offers Convert-to-Branch / Catch Up instead of the
      // preview silently retargeting onto unpublished work. Computed into
      // a local and assigned ONCE: blanking this.baseDrift up front left
      // a transient no-drift window during every refresh (row flicker,
      // and readers mid-refresh saw undefined while drift persisted).
      let drift:
        | { ahead: number; sha: string; resetTo: string; included: boolean }
        | undefined;
      const effective = await resolveBaseSha(wt.path, integrationBaseRef());
      const baseName = integrationBaseRef().replace(/^origin\//, '');
      const localSha = await revParseCommit(wt.path, `refs/heads/${baseName}`);
      if (
        effective &&
        localSha &&
        localSha !== effective &&
        !(await gitOk(wt.path, [
          'merge-base',
          '--is-ancestor',
          localSha,
          effective,
        ]))
      ) {
        const ahead =
          Number(
            (
              await git(wt.path, [
                'rev-list',
                '--count',
                `${effective}..${localSha}`,
              ]).catch(() => '0')
            ).trim(),
          ) || 0;
        if (ahead > 0) {
          drift = {
            ahead,
            sha: localSha,
            resetTo: effective,
            // Included by default: unpushed base work is unlanded work,
            // shown in the preview like any lane. Uncheck persists the
            // base name in focus-excluded.
            included: !(await listExcludedLanes(wt.path)).includes(baseName),
          };
        }
      }
      this.baseDrift = drift;
      this.lanes = await listAppliedLanes(wt.path);
      const explicit = await listCandidateLanes(wt.path);
      this.explicit = explicit;
      const excluded = await listExcludedLanes(wt.path);
      // Auto-membership: a worktree whose own base — override or GENUINE
      // inference, never the configured fallback — matches the integration
      // base is a candidate automatically. Stacked lanes (base = parent
      // branch) stay out, and so do branches whose base we merely guessed.
      const integBase = integrationBaseRef().replace(/^origin\//, '');
      const auto: string[] = [];
      for (const w of this.host.getWorktrees()) {
        if (
          w.detached ||
          w.path === wt.path ||
          explicit.includes(w.branch) ||
          this.lanes.includes(w.branch) ||
          excluded.includes(w.branch) ||
          !isLaneBranch(w.branch, integrationBaseRef())
        ) {
          continue;
        }
        const base = await this.host.genuineBaseFor(w.path);
        if (!base || base.replace(/^origin\//, '') !== integBase) {
          continue;
        }
        auto.push(w.branch);
        // Empty lane (created off the base, nothing committed yet): apply it
        // on sight. There is nothing to hide — merging it is a literal no-op
        // — and it means the first commit flows into the preview instead of
        // waiting on a checkbox. Recorded as a candidate too, so this happens
        // exactly ONCE per branch: the explicit guard above skips it forever
        // after, and an uncheck stays unchecked.
        const laneSha = await revParseCommit(wt.path, `refs/heads/${w.branch}`);
        if (
          effective &&
          laneSha &&
          (await gitOk(wt.path, [
            'merge-base',
            '--is-ancestor',
            laneSha,
            effective,
          ])) &&
          (await laneNeverDiverged(wt.path, laneSha, effective))
        ) {
          // Cut from a stale base, the lane reads as "behind" while having
          // nothing to rebase. Re-point it instead — lossless, since it has
          // no commits — so its first commit starts from the CURRENT base.
          if (laneSha !== effective) {
            const ff = await fastForwardEmptyLane(w.path, integrationBaseRef());
            this.host.output.appendLine(
              ff.status === 'done'
                ? `Empty lane ${w.branch} fast-forwarded to ${integBase}`
                : `Empty lane ${w.branch} left where it is (${ff.status}${
                    'message' in ff ? `: ${ff.message}` : ''
                  })`,
            );
          }
          await addCandidateLane(wt.path, w.branch);
          await addAppliedLane(wt.path, w.branch);
          explicit.push(w.branch);
          this.lanes.push(w.branch);
          this.host.output.appendLine(
            `Integration lane auto-applied (new worktree off ${integBase}): ${w.branch}`,
          );
        }
      }
      // Applied lanes (e.g. from the shell script) always show as candidates
      this.candidates = [
        ...new Set([...explicit, ...this.lanes, ...auto]),
      ].sort();
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
      // MERGE_HEAD in the integration checkout itself (external script /
      // by hand) — gates the Abort Integration Merge menu item, which
      // otherwise showed permanently for a state the off-tree engine
      // can no longer produce.
      this.mergePaused = await baseMergeInProgress(wt.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`Read lanes failed: ${message}`);
      this.lanes = [];
      this.candidates = [];
      this.explicit = [];
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
    return { ok: true, lanes: this.lanes.slice(), skipped: [], landed: [], resolved: [] };
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
   * Keep the pre-commit guard in step with integration state. Installed
   * while integration is on, removed when it goes off, and re-pointed when
   * the branch is renamed — reconciled from refreshState rather than from
   * the enable/disable commands so it also covers checkouts made by hand
   * and repos that had integration on before the guard existed.
   *
   * Failure is logged, never surfaced: a repo where hooks cannot be written
   * (read-only .git, an unusual hooksPath) still works exactly as it did
   * before — it just does not get the extra warning.
   */
  private async syncCommitGuard(
    workingPath: string | undefined,
    branch: string,
  ): Promise<void> {
    const cwd = workingPath ?? this.host.getRepoCwd();
    if (!cwd) {
      return;
    }
    try {
      if (!workingPath || !isCommitGuardEnabled()) {
        await uninstallCommitGuard(cwd);
        return;
      }
      const result = await installCommitGuard(cwd, branch);
      if (result === 'foreign') {
        this.host.output.appendLine(
          `Commit guard not installed: ${cwd} has a pre-commit hook that is not a shell script — chaining into it could break every commit, so it was left alone`,
        );
      } else if (result !== 'unchanged') {
        this.host.output.appendLine(
          result === 'chained'
            ? `Commit guard chained into the existing pre-commit hook: refusing commits on ${branch}`
            : `Commit guard ${result}: refusing commits on ${branch}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`Commit guard sync failed: ${message}`);
    }
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
    // The pin belongs to the OLD base — drop it so refreshState re-pins
    // fresh on the new one.
    await clearBasePin(this.integrationPath).catch(() => {});
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
      // state the caller just wrote. Reasons ACCUMULATE: overwriting lost
      // a queued manual's fetch when hide/apply queued after it, leaving
      // landed/badge state on a stale origin (CI-only timing).
      this.rebuildQueued = this.rebuildQueued
        ? `${this.rebuildQueued} + ${reason}`
        : reason;
      return { ok: false, code: 'busy', message: 'rebuild already running' };
    }
    this.rebuildInFlight = true;
    const t0 = Date.now();
    try {
      if (reason.includes('manual')) {
        // Manual rebuild = "give me reality": refresh the base tip first.
        // includes(): the manual marker must survive queueing — both the
        // '(queued)' suffix and accumulation with other queued reasons.
        this.lastBaseFetchAt = Date.now();
        await fetchIntegrationBase(workingPath, integrationBaseRef());
      }
      const result = await rebuildIntegration(workingPath, integrationBaseRef());
      if (result.ok) {
        this.error = undefined;
        this.autoResolved = result.resolved;
        for (const r of result.resolved) {
          this.host.output.appendLine(
            `Lane ${r.lane} auto-resolved${
              r.lossless.length > 0
                ? ` · lossless: ${r.lossless.join(', ')}`
                : ''
            }${
              r.lossy.length > 0
                ? ` · lane-wins (hunks dropped): ${r.lossy.join(', ')}`
                : ''
            }`,
          );
        }
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
      } else if (result.code === 'unique' && isIntegrationAbsorbEnabled()) {
        // Work committed directly on the integration checkout. The rebuild
        // refuses rather than destroy it, which protects the commits but
        // deadlocks the preview — absorbing is the exit. On success the
        // work lands on the base as ordinary drift and the queued rebuild
        // (below) picks up where this one stopped.
        const absorbed = await this.absorbStrays();
        if (absorbed?.ok) {
          this.error = undefined;
          this.rebuildQueued = this.rebuildQueued
            ? `${this.rebuildQueued} + absorbed strays`
            : 'absorbed strays';
        } else {
          this.error = { code: result.code, message: result.message };
          this.host.output.appendLine(
            `Integration rebuild failed (${reason}, ${result.code}): ${result.message}`,
          );
        }
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
    // Re-adding is also how an excluded auto member comes back
    await dropExcludedLane(this.integrationPath, branch);
    await addCandidateLane(this.integrationPath, branch);
    await this.refreshState();
    this.host.fireTreeData();
  }

  /**
   * Drop a branch from the Integration row; rebuild if it was applied.
   * Also records an exclusion — auto members (base matches) would just
   * reappear on the next refresh otherwise, and Remove must be a real
   * exit for every row. Add to Integration clears the exclusion.
   */
  async removeCandidate(branch: string): Promise<RebuildResult> {
    if (!this.integrationPath) {
      return { ok: false, code: 'error', message: 'no integration worktree' };
    }
    await dropCandidateLane(this.integrationPath, branch);
    await addExcludedLane(this.integrationPath, branch);
    if (this.lanes.includes(branch)) {
      return this.hide(branch);
    }
    await this.refreshState();
    this.host.fireTreeData();
    return { ok: true, lanes: this.lanes.slice(), skipped: [], landed: [], resolved: [] };
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
    // (and applying an excluded branch is an explicit opt back in)
    await dropExcludedLane(this.integrationPath, branch);
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

  /**
   * Deliberately advance the frozen base to the local <base> tip (the
   * Catch Up exit for base drift) and rebuild onto it.
   */
  /**
   * Toggle whether the base's unpushed commits (the drift lane) join the
   * preview. Exclusion persists as the base name in focus-excluded, so
   * "never show main's local noise" survives future commits.
   */
  async setBaseDriftIncluded(included: boolean): Promise<RebuildResult> {
    if (!this.integrationPath) {
      return { ok: false, code: 'error', message: 'no integration worktree' };
    }
    const baseName = integrationBaseRef().replace(/^origin\//, '');
    if (included) {
      await dropExcludedLane(this.integrationPath, baseName);
    } else {
      await addExcludedLane(this.integrationPath, baseName);
    }
    await this.refreshState();
    this.host.fireTreeData();
    return this.runRebuild(
      included ? `include ${baseName} drift` : `exclude ${baseName} drift`,
    );
  }

  /**
   * The checkout that absorbed work goes to: the base branch's own
   * worktree. Landing it there makes it ordinary base drift, which is
   * already a first-class lane with Catch Up and Move-to-Branch exits —
   * so the rescue needs no escape hatches of its own.
   */
  private async absorbTarget(): Promise<AbsorbTarget | undefined> {
    if (!this.integrationPath) {
      return undefined;
    }
    const baseName = integrationBaseRef().replace(/^origin\//, '');
    if (!(await gitOk(this.integrationPath, [
      'rev-parse',
      '-q',
      '--verify',
      `refs/heads/${baseName}`,
    ]))) {
      return undefined; // no base branch at all — nothing to absorb into
    }
    const path = await checkoutForBranch(this.integrationPath, baseName);
    // Prefer a checkout so the replay leaves its working tree consistent;
    // fall back to the ref, which is the ONLY option when integration was
    // enabled by switching a checkout in place — the base then has no
    // worktree of its own.
    return path
      ? { kind: 'checkout', path, branch: baseName }
      : { kind: 'ref', branch: baseName };
  }

  /**
   * Move commits made directly on the integration branch onto the base.
   * Runs unattended: a commit is an explicit act marking a unit of work
   * complete, so nothing is taken out from under anyone. Uncommitted edits
   * are deliberately NOT absorbed automatically — an agent may still be
   * mid-write, and yanking files it is about to read back is worse than
   * the deadlock.
   */
  async absorbStrays(
    options: { confirmed?: boolean } = {},
  ): Promise<AbsorbResult | undefined> {
    const workingPath = this.integrationPath;
    if (!workingPath) {
      return undefined;
    }
    // One attempt per integration tip: a target that keeps refusing (dirty,
    // or a conflict needing a human) must not re-arm the rebuild queue on
    // every tick.
    const head = await revParseCommit(workingPath, 'HEAD');
    if (!options.confirmed && head && head === this.lastAbsorbHead) {
      return undefined;
    }
    this.lastAbsorbHead = head;
    const target = await this.absorbTarget();
    if (!target) {
      this.host.output.appendLine(
        'Integration strays: the base branch does not exist — cannot absorb',
      );
      return {
        ok: false,
        code: 'no-target',
        message: 'the base branch does not exist locally',
      };
    }
    // Added files are the one shape a replay cannot vet (see
    // addedPathsInCommits). They only carry that risk while lanes are
    // merged in — with a base-only chain the integration tree IS the base,
    // so there is no lane context for anything to depend on. In that case
    // ask instead of moving work unattended.
    if (!options.confirmed && this.lanes.length > 0) {
      const baseSha = await resolveBaseSha(workingPath, integrationBaseRef());
      const strays = baseSha
        ? await findStrayCommits(workingPath, baseSha)
        : [];
      const added = await addedPathsInCommits(
        workingPath,
        strays.map((c) => c.sha),
      );
      if (added.length > 0) {
        this.host.output.appendLine(
          `Integration strays add ${added.join(', ')} — not absorbed automatically (lanes applied)`,
        );
        void vscode.window
          .showWarningMessage(
            `Git Workflow: the integration checkout has commits adding ${added.join(', ')}. Merged lanes are in this tree, so those files may depend on code the base does not have — absorbing is not automatic here.`,
            'Absorb Anyway',
            'Move to a Branch…',
          )
          .then((choice) => {
            if (choice === 'Absorb Anyway') {
              void vscode.commands.executeCommand(
                'worktreeCompare.absorbIntegrationCommits',
              );
            } else if (choice === 'Move to a Branch…') {
              void vscode.commands.executeCommand(
                'worktreeCompare.branchifyBaseDrift',
              );
            }
          });
        return {
          ok: false,
          code: 'needs-confirmation',
          message: `stray commits add ${added.join(', ')}`,
          files: added,
        };
      }
    }
    const result = await absorbStrayCommits(
      workingPath,
      integrationBaseRef(),
      target,
    );
    if (result.ok) {
      const baseName = integrationBaseRef().replace(/^origin\//, '');
      this.host.output.appendLine(
        `Absorbed ${result.commits} stray commit(s) from the integration checkout into ${baseName}`,
      );
      void vscode.window
        .showInformationMessage(
          `Git Workflow: moved ${result.commits} commit(s) made on the integration checkout onto ${baseName} — they now show as unpushed base work.`,
          'Move to a Branch…',
        )
        .then((choice) => {
          if (choice) {
            void vscode.commands.executeCommand(
              'worktreeCompare.branchifyBaseDrift',
            );
          }
        });
    } else if (result.code !== 'nothing') {
      this.host.output.appendLine(
        `Absorbing integration strays failed (${result.code}): ${result.message}${
          result.files?.length ? ` · ${result.files.join(', ')}` : ''
        }`,
      );
    }
    return result;
  }

  /** Absorb stray commits the user explicitly approved, then rebuild. */
  async absorbStraysConfirmed(): Promise<AbsorbResult | undefined> {
    const result = await this.absorbStrays({ confirmed: true });
    if (result?.ok) {
      await this.runRebuild('absorbed strays (confirmed)');
      this.host.refresh();
    }
    return result;
  }

  /**
   * Move UNCOMMITTED integration edits onto the base. Only ever runs from
   * an explicit command — see absorbStrays for why this is never automatic.
   */
  async absorbEdits(): Promise<AbsorbResult> {
    const workingPath = this.integrationPath;
    if (!workingPath) {
      return { ok: false, code: 'error', message: 'no integration worktree' };
    }
    const target = await this.absorbTarget();
    // Uncommitted work has to land in a working tree, so unlike stray
    // COMMITS this one cannot fall back to the ref. Committing it on the
    // user's behalf would be deciding the work is finished.
    if (target?.kind !== 'checkout') {
      return {
        ok: false,
        code: 'no-target',
        message: target
          ? `${target.branch} has no worktree — check it out somewhere, or commit these edits and let them absorb`
          : 'the base branch does not exist locally',
      };
    }
    const result = await absorbDirtyEdits(workingPath, target.path);
    if (result.ok) {
      this.host.output.appendLine(
        `Absorbed uncommitted integration edits into ${target.path}`,
      );
      // The checkout is clean again — the dirty guard no longer blocks
      await this.runRebuild('absorbed edits');
    } else {
      this.host.output.appendLine(
        `Absorbing integration edits failed (${result.code}): ${result.message}`,
      );
    }
    return result;
  }

  async catchUpBase(): Promise<RebuildResult> {
    if (!this.integrationPath || !this.baseDrift) {
      return { ok: false, code: 'error', message: 'no base drift to catch up' };
    }
    await writeBasePin(this.integrationPath, this.baseDrift.sha);
    this.host.output.appendLine(
      `Integration base caught up to ${this.baseDrift.sha.slice(0, 10)}`,
    );
    const result = await this.runRebuild('base caught up');
    this.host.refresh();
    return result;
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
