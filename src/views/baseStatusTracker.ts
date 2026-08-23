import type { DiscoveredWorktree } from '../discovery/scanner';
import { baseStatusFor, type BaseStatus } from '../git/integration';
import { preferRemoteTrackingRef, resolveBaseRef } from '../git/worktree';

export interface BaseStatusHost {
  readonly output: { appendLine(value: string): void };
  getWorktrees(): DiscoveredWorktree[];
  /** Rows the Worktree panel shows (integration checkout excluded). */
  listedWorktrees(): DiscoveredWorktree[];
  /** Inference fallback (integration base while integration is on). */
  fallbackBaseRef(): string;
  fireTreeData(): void;
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
  /** Row badges: path → status vs its base. */
  private readonly statuses = new Map<string, BaseStatus & { baseRef: string }>();
  /** Conflict-probe memo keyed refSha:baseSha (owned by baseStatusFor). */
  private readonly probeMemo = new Map<string, boolean>();
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
    for (const key of [...this.inferred.keys()]) {
      if (key.startsWith(`${worktreePath}\0`)) {
        this.inferred.delete(key);
      }
    }
  }

  /** Full refresh drops inference (overrides persist). */
  invalidateAll(): void {
    this.inferred.clear();
  }

  async baseFor(worktreePath: string): Promise<string> {
    const override = this.overrides.get(worktreePath);
    if (override) {
      return override;
    }
    const branch =
      this.host.getWorktrees().find((w) => w.path === worktreePath)?.branch ??
      '';
    const key = `${worktreePath}\0${branch}`;
    const cached = this.inferred.get(key);
    if (cached) {
      return cached;
    }
    const base = await resolveBaseRef(worktreePath, this.host.fallbackBaseRef());
    this.inferred.set(key, base);
    return base;
  }

  /** Row badge for a worktree (undefined = up to date / unknown). */
  status(
    worktreePath: string,
  ):
    | { behind: number; ahead: number; conflicts: boolean; baseRef: string }
    | undefined {
    return this.statuses.get(worktreePath);
  }

  /**
   * Row badges: how each lane relates to its base. Bounded-parallel, and
   * probe-memoized by refSha:baseSha so merge-tree reruns only when a tip
   * moves.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const targets = this.host.listedWorktrees().filter((w) => !w.detached);
      let changed = false;
      const live = new Set<string>();
      const worker = async (wt: DiscoveredWorktree) => {
        live.add(wt.path);
        try {
          const baseRef = await this.baseFor(wt.path);
          const prev = this.statuses.get(wt.path);
          const status = await baseStatusFor(
            wt.path,
            'HEAD',
            baseRef,
            this.probeMemo,
          );
          if (!status) {
            if (this.statuses.delete(wt.path)) {
              changed = true;
            }
            return;
          }
          const entry = { ...status, baseRef };
          this.statuses.set(wt.path, entry);
          if (
            !prev ||
            prev.behind !== entry.behind ||
            prev.conflicts !== entry.conflicts ||
            prev.baseRef !== entry.baseRef
          ) {
            changed = true;
          }
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
            if (!wt) {
              return;
            }
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
      if (changed) {
        this.host.fireTreeData();
      }
    } finally {
      this.inFlight = false;
    }
  }
}
