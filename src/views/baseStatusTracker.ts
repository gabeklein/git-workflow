import type { DiscoveredWorktree } from '../discovery/scanner';
import {
  autoRebaseLanes,
  baseStatusFor,
  catchUpStrategy,
  isLaneBranch,
} from '../git/integration';
import {
  abortBaseMerge,
  abortLaneRebase,
  baseMergeInProgress,
  rebaseInProgress,
  startBaseMerge,
  startLaneRebase,
} from '../git/laneOps';
import {
  inferBaseRef,
  preferRemoteTrackingRef,
  resolveBaseRef,
} from '../git/worktree';

export interface BaseStatusHost {
  readonly output: { appendLine(value: string): void };
  getWorktrees(): DiscoveredWorktree[];
  /** Rows the Worktree panel shows (integration checkout excluded). */
  listedWorktrees(): DiscoveredWorktree[];
  /** Inference fallback (integration base while integration is on). */
  fallbackBaseRef(): string;
  fireTreeData(): void;
}

/** Row badge: how a worktree relates to its base, plus paused git state. */
export interface WorktreeBaseState {
  behind: number;
  ahead: number;
  conflicts: boolean;
  /** A rebase is paused in this worktree (HEAD is detached mid-rebase). */
  rebasing: boolean;
  /** A merge is paused in this worktree (MERGE_HEAD present). */
  merging: boolean;
  baseRef: string;
}

/**
 * THE per-worktree base (override → cached inference → inference) plus the
 * row badges computed against it. Compare snapshots and badges both read
 * baseFor(), so the diff you read and the badge you see agree by
 * construction.
 */
export class BaseStatusTracker {
  /** Manual Change Base Ref overrides, by worktree path. */
  private readonly overrides = new Map<string, string>();
  /** Inferred per-worktree base (path\0branch → ref). */
  private readonly inferred = new Map<string, string>();
  /** Genuine-inference results only (path\0branch → ref | ''=none). */
  private readonly genuine = new Map<string, string>();
  /** Row badges: path → status vs its base. */
  private readonly statuses = new Map<string, WorktreeBaseState>();
  /** Conflict-probe memo keyed refSha:baseSha (owned by baseStatusFor). */
  private readonly probeMemo = new Map<string, boolean>();
  /** Auto catch-up attempts already made, path → refSha:baseSha — one
   *  attempt per tip pair, so a failure never loops. */
  private readonly autoTried = new Map<string, string>();
  private inFlight = false;

  constructor(private readonly host: BaseStatusHost) {}

  getOverride(worktreePath: string): string | undefined {
    return this.overrides.get(worktreePath);
  }

  async setOverride(worktreePath: string, baseRef: string): Promise<string> {
    const preferred = await preferRemoteTrackingRef(worktreePath, baseRef);
    this.overrides.set(worktreePath, preferred);
    this.invalidate(worktreePath);
    void this.refresh();
    return preferred;
  }

  /** Drop cached inference for one worktree (all branches). */
  invalidate(worktreePath: string): void {
    for (const map of [this.inferred, this.genuine]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(`${worktreePath}\0`)) map.delete(key);
      }
    }
  }

  /** Full refresh drops inference (overrides persist). */
  invalidateAll(): void {
    this.inferred.clear();
    this.genuine.clear();
  }

  async baseFor(worktreePath: string): Promise<string> {
    const override = this.overrides.get(worktreePath);
    if (override) return override;
    const branch =
      this.host.getWorktrees().find((w) => w.path === worktreePath)?.branch ??
      '';
    const key = `${worktreePath}\0${branch}`;
    const cached = this.inferred.get(key);
    if (cached) return cached;
    const base = await resolveBaseRef(worktreePath, this.host.fallbackBaseRef());
    this.inferred.set(key, base);
    return base;
  }

  /**
   * Override ?? GENUINE inference (branch config / reflog / upstream) —
   * never the configured fallback, which equals the integration base while
   * integration is on. undefined = no evidence; auto flows (membership
   * derivation in particular) must not enroll on a guess.
   */
  async genuineBaseFor(worktreePath: string): Promise<string | undefined> {
    const override = this.overrides.get(worktreePath);
    if (override) return override;
    const branch =
      this.host.getWorktrees().find((w) => w.path === worktreePath)?.branch ??
      '';
    const key = `${worktreePath}\0${branch}`;
    const cached = this.genuine.get(key);
    if (cached !== undefined) return cached || undefined;
    const base = await inferBaseRef(worktreePath);
    this.genuine.set(key, base ?? '');
    return base;
  }

  /** Row badge for a worktree (undefined = up to date / unknown). */
  status(worktreePath: string): WorktreeBaseState | undefined {
    return this.statuses.get(worktreePath);
  }

  /**
   * Row badges: how each lane relates to its base. Bounded-parallel, and
   * probe-memoized by refSha:baseSha so merge-tree reruns only when a tip
   * moves. Detached worktrees are probed too: a paused rebase detaches
   * HEAD, and that is exactly when the row must show Continue/Abort.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const targets = this.host.listedWorktrees();
      let changed = false;
      const live = new Set<string>();
      const worker = async (wt: DiscoveredWorktree) => {
        live.add(wt.path);
        try {
          const prev = this.statuses.get(wt.path);
          const rebasing = await rebaseInProgress(wt.path);
          const merging = rebasing ? false : await baseMergeInProgress(wt.path);
          if (rebasing || merging) {
            // Ahead/behind vs a mid-operation HEAD is noise — show the
            // paused state alone until the operation finishes.
            const entry: WorktreeBaseState = {
              behind: 0,
              ahead: 0,
              conflicts: false,
              rebasing,
              merging,
              baseRef: prev?.baseRef ?? '',
            };
            this.statuses.set(wt.path, entry);
            if (
              !prev ||
              prev.rebasing !== rebasing ||
              prev.merging !== merging
            ) {
              changed = true;
            }
            return;
          }
          if (wt.detached) {
            if (this.statuses.delete(wt.path)) changed = true;
            return;
          }
          const baseRef = await this.baseFor(wt.path);
          const status = await baseStatusFor(
            wt.path,
            'HEAD',
            baseRef,
            this.probeMemo,
          );
          if (!status) {
            if (this.statuses.delete(wt.path)) changed = true;
            return;
          }
          const entry: WorktreeBaseState = {
            behind: status.behind,
            ahead: status.ahead,
            conflicts: status.conflicts,
            rebasing: false,
            merging: false,
            baseRef,
          };
          this.statuses.set(wt.path, entry);
          if (
            !prev ||
            prev.behind !== entry.behind ||
            prev.conflicts !== entry.conflicts ||
            prev.baseRef !== entry.baseRef ||
            prev.rebasing ||
            prev.merging
          ) {
            changed = true;
          }
          if (await this.autoCatchUp(wt, entry, status.refSha, status.baseSha))
            changed = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.host.output.appendLine(
            `Base status failed for ${wt.branch}: ${message}`,
          );
        }
      };
      // Bounded parallelism: probes are independent
      const queue = targets.slice();
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (;;) {
            const wt = queue.shift();
            if (!wt) return;
            await worker(wt);
          }
        }),
      );
      for (const key of [...this.statuses.keys()]) {
        if (!live.has(key)) {
          this.statuses.delete(key);
          changed = true;
        }
      }
      if (changed) this.host.fireTreeData();
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Proactive catch-up (autoRebaseLanes: local-only): a linked worktree
   * that is clean, behind, conflict-free, and UNPUSHED is brought up to
   * date as the base moves — pushed branches are never rewritten
   * automatically. Method follows catchUpStrategy (scope stays
   * unpushed-only). Attempts are memoized per (tip, base) so a failure
   * never loops; a conflicting attempt aborts immediately — the user did
   * not ask for this operation, so it must never leave a paused state —
   * and the row shows 'conflicts with <base>' for the manual flow.
   * Returns true when the row's status changed.
   */
  private async autoCatchUp(
    wt: DiscoveredWorktree,
    entry: WorktreeBaseState,
    refSha: string,
    baseSha: string,
  ): Promise<boolean> {
    if (
      autoRebaseLanes() === 'off' ||
      entry.behind === 0 ||
      entry.conflicts ||
      wt.isRootCheckout ||
      wt.isMainWorktree ||
      wt.publishState !== 'local' ||
      !isLaneBranch(wt.branch, entry.baseRef)
    ) {
      return false;
    }
    const key = `${refSha}:${baseSha}`;
    if (this.autoTried.get(wt.path) === key) return false;
    this.autoTried.set(wt.path, key);
    try {
      const viaMerge = catchUpStrategy() === 'merge';
      const result = viaMerge
        ? await startBaseMerge(wt.path, entry.baseRef, wt.branch)
        : await startLaneRebase(wt.path, entry.baseRef);
      if (result.status === 'done') {
        this.host.output.appendLine(
          `Auto-${viaMerge ? 'merged base into' : 'rebased'} ${wt.branch} (was ${entry.behind} behind ${entry.baseRef})`,
        );
        this.statuses.set(wt.path, {
          ...entry,
          behind: 0,
          conflicts: false,
        });
        return true;
      }
      if (result.status === 'conflicts') {
        await (viaMerge
          ? abortBaseMerge(wt.path)
          : abortLaneRebase(wt.path)
        ).catch(() => {});
        this.statuses.set(wt.path, { ...entry, conflicts: true });
        this.host.output.appendLine(
          `Auto catch-up ${wt.branch} conflicts with ${entry.baseRef} — aborted, row marked`,
        );
        return true;
      }
      this.host.output.appendLine(
        `Auto catch-up ${wt.branch} skipped (${result.status}: ${result.message})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(
        `Auto catch-up ${wt.branch} failed: ${message}`,
      );
    }
    return false;
  }
}
