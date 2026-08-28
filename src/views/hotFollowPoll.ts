import * as vscode from 'vscode';

/**
 * The cadence behind hot-follow: how often the selected worktree's status
 * and diff are re-read when nothing has told us they changed.
 *
 * Two paces, because the two situations are not alike. While work is
 * landing — an agent writing files, a rebase running — a stale panel is
 * wrong within a second, so the poll runs fast. The rest of the time it is
 * a fallback for events the editor never delivers, and a fast poll would
 * be two git calls a second forever. Something happening moves it to
 * ACTIVE; a stretch of quiet steps it back to IDLE.
 *
 * "Something happening" is deliberately whatever the caller says it is —
 * a file event, a poll that found a real change — rather than anything
 * this class can observe. It only owns the timer and the decay.
 *
 * An unfocused window never ticks: nobody is looking, and the pace is
 * allowed to relax while they are away so returning to the window does not
 * find it polling at active speed for no reason.
 */
export class HotFollowPoll implements vscode.Disposable {
  private pace: 'active' | 'idle' = 'idle';
  private lastActiveAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly output: { appendLine(value: string): void },
    /** One content refresh of whatever is selected. */
    private readonly tick: (reason: string) => Promise<void>,
  ) {}

  /** For log lines that report which pace produced an update. */
  get currentPace(): 'active' | 'idle' {
    return this.pace;
  }

  /** (Re)read the configured intervals and start over at idle pace. */
  restart(): void {
    this.stop();
    const idle = this.idleIntervalMs();
    if (idle <= 0) {
      this.output.appendLine(
        'Hot-follow poll disabled (contentRefreshIntervalMs=0); save/create/delete events still refresh',
      );
      return;
    }
    this.pace = 'idle';
    this.output.appendLine(
      `Hot-follow poll: idle=${idle}ms active=${this.activeIntervalMs()}ms relaxAfter=${this.idleAfterMs()}ms`,
    );
    this.schedule();
  }

  /** Something changed — go (or stay) fast, and reset the quiet timer. */
  markActive(reason: string): void {
    const was = this.pace;
    this.pace = 'active';
    this.lastActiveAt = Date.now();
    if (was !== 'active') {
      this.output.appendLine(`Hot-follow pace → active (${reason})`);
      // Pull the next poll forward without a full restart/log spam
      this.schedule();
    }
  }

  /** Nothing changed — step back to idle once it has been quiet long enough. */
  relax(): void {
    if (this.pace !== 'active') return;
    if (Date.now() - this.lastActiveAt < this.idleAfterMs()) return;
    this.pace = 'idle';
    this.output.appendLine('Hot-follow pace → idle (quiet)');
  }

  dispose(): void {
    this.stop();
  }

  /** Idle (relaxed) poll interval; 0 disables polling entirely. */
  private idleIntervalMs(): number {
    return vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<number>('contentRefreshIntervalMs', 0);
  }

  /** Active (rapid) poll while changes keep landing. */
  private activeIntervalMs(): number {
    const configured = vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<number>('contentRefreshActiveIntervalMs', 1500);
    const idle = this.idleIntervalMs();
    if (idle <= 0) return configured;
    // Never slower than idle; never below 500ms
    return Math.max(500, Math.min(configured, idle));
  }

  /** Quiet time before stepping back from active → idle pace. */
  private idleAfterMs(): number {
    return vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<number>('contentRefreshIdleAfterMs', 15000);
  }

  private stop(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.stop();
    if (this.idleIntervalMs() <= 0) return;
    this.relax();
    const ms =
      this.pace === 'active' ? this.activeIntervalMs() : this.idleIntervalMs();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runTick();
    }, ms);
  }

  private async runTick(): Promise<void> {
    try {
      if (vscode.window.state.focused) await this.tick('poll');
      else this.relax();
    } finally {
      this.schedule();
    }
  }
}
