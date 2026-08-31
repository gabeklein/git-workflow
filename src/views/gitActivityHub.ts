import * as vscode from 'vscode';
import {
  resolveRepoCommonDirs,
  worktreeListFingerprint,
} from '../git/discovery';
import { GitDirWatcher } from '../git/gitWatcher';
import { refreshStamp } from '../git/refreshSignal';

/**
 * Worktree-list / preview check cadence. Primary signal is the .git
 * fs.watch (GitDirWatcher); while that is active the poll is only a slow
 * fallback for filesystems that drop events. Without watchers (watch setup
 * failed) the poll carries detection alone at the fast interval.
 */
const POLL_FALLBACK_MS = 30000;
const POLL_NO_WATCHER_MS = 4000;

interface GitActivityHost {
  readonly output: { appendLine(value: string): void };
  /** Worktree membership changed (fingerprint moved) — rediscover. */
  onMembershipChanged(reason: string): void;
  /** Runs after the fingerprint check on every event/poll tick. */
  onTick(reason: string): Promise<void>;
  /** Fired after each completed state check (cheap change signal). */
  onActivity(): void;
  /** Somebody asked for a full look — `gw-lane refresh` (see
   *  refreshSignal). Rediscovery, not just a tick: the rows an agent wants
   *  refreshed after working in a checkout come from discovery. */
  onRefreshRequested(reason: string): void;
}

/**
 * Owns the .git watchers, the fallback poll, the membership fingerprint,
 * and the in-flight/queued dedupe around state checks.
 */
export class GitActivityHub implements vscode.Disposable {
  private watchers: GitDirWatcher[] = [];
  private generation = 0;
  private pollTimer: NodeJS.Timeout | undefined;
  private fingerprint: string | undefined;
  private refreshedAt = 0;
  private refreshSeeded = false;
  private checkInFlight = false;
  private checkQueued = false;

  constructor(private readonly host: GitActivityHost) {}

  /**
   * (Re)attach Node fs.watch to each repo's .git (refs/, logs/, worktrees/,
   * packed-refs). Events run the same state check the poll does — the poll
   * stays on as a slow fallback for filesystems that drop events.
   */
  async restart(): Promise<void> {
    const generation = ++this.generation;
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers = [];
    try {
      const commonDirs = await resolveRepoCommonDirs();
      if (generation !== this.generation) return;
      for (const dir of commonDirs) {
        const watcher = new GitDirWatcher(
          dir,
          () => void this.check('.git event'),
          this.host.output,
        );
        if ((await watcher.start()) && generation === this.generation) {
          this.watchers.push(watcher);
        } else {
          watcher.dispose();
        }
      }
      this.host.output.appendLine(
        this.watchers.length > 0
          ? `.git watch active on ${this.watchers.length} repo(s); poll fallback ${POLL_FALLBACK_MS}ms`
          : `.git watch unavailable — polling every ${POLL_NO_WATCHER_MS}ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`.git watch setup failed: ${message}`);
    }
    this.restartPoll();
  }

  restartPoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.fingerprint = undefined;
    this.schedulePoll();
  }

  private pollMs(): number {
    return this.watchers.some((w) => w.active)
      ? POLL_FALLBACK_MS
      : POLL_NO_WATCHER_MS;
  }

  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void (async () => {
        try {
          await this.check('poll');
        } finally {
          this.schedulePoll();
        }
      })();
    }, this.pollMs());
  }

  /**
   * Has anyone asked for a full look since the last check?
   *
   * Seeded on the first pass without firing — an editor opening a repo
   * where somebody ran `gw-lane refresh` last week should not treat that
   * as a live request. After that, any newer stamp is one.
   */
  private async checkRefreshRequest(reason: string): Promise<void> {
    let stamp = 0;
    for (const common of await resolveRepoCommonDirs().catch(() => [])) {
      stamp = Math.max(stamp, (await refreshStamp(common)) ?? 0);
    }
    // Seed on the FIRST check whether or not a stamp exists yet. Seeding
    // only when the file is already there swallowed the first request a
    // repo ever made: the file appearing later looked exactly like the
    // seed, so the one signal nobody had sent before was the one signal
    // that did nothing.
    if (!this.refreshSeeded) {
      this.refreshSeeded = true;
      this.refreshedAt = stamp;
      return;
    }
    if (stamp > this.refreshedAt) {
      this.refreshedAt = stamp;
      this.host.onRefreshRequested(`${reason} (refresh requested)`);
    }
  }

  /**
   * Shared state check for .git events and the fallback poll: rediscover
   * when worktree membership changed, then run the host tick.
   */
  private async check(reason: string): Promise<void> {
    if (this.checkInFlight) {
      // An event landed mid-check: its change may predate this run's reads,
      // so run once more when the current check finishes.
      this.checkQueued = true;
      return;
    }
    this.checkInFlight = true;
    try {
      await this.checkRefreshRequest(reason);
      const next = await worktreeListFingerprint();
      if (this.fingerprint === undefined) {
        this.fingerprint = next;
      } else if (next !== this.fingerprint) {
        this.fingerprint = next;
        this.host.onMembershipChanged(reason);
      }
      await this.host.onTick(reason);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(
        `Worktree state check failed (${reason}): ${message}`,
      );
    } finally {
      this.checkInFlight = false;
      this.host.onActivity();
      if (this.checkQueued) {
        this.checkQueued = false;
        void this.check(`${reason} (queued)`);
      }
    }
  }

  dispose(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.generation++;
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers = [];
  }
}
