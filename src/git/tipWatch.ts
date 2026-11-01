import { git } from './exec';

/**
 * Remembers what a set of refs resolved to, and says when that changed.
 *
 * The .git watcher only says that *something* moved; this is the cheap
 * second question — did it move anything Focus is showing? One rev-parse
 * per subject per tick, and a recompute only when the answer is yes.
 */
export class TipWatch {
  private readonly seen = new Map<string, string>();

  /**
   * True when `refs` (resolved in `cwd`) differ from the last call under
   * `key` — and on the first call, since nothing proves the view current.
   * An unresolvable ref counts as moved: whoever recomputes finds out why.
   */
  async moved(key: string, cwd: string, refs: string[]): Promise<boolean> {
    let now: string;
    try {
      now = (await git(cwd, ['rev-parse', ...refs])).trim();
    } catch {
      this.seen.delete(key);
      return true;
    }
    const before = this.seen.get(key);
    this.seen.set(key, now);
    return before !== now;
  }

  forget(key: string): void {
    this.seen.delete(key);
  }
}
