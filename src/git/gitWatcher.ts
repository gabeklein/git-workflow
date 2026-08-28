import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Event-driven change detection on a repo's .git (common dir), using Node
 * fs.watch — NOT the VS Code host watcher (the .git dirs are usually outside
 * the workspace folders and excluded by files.watcherExclude anyway).
 *
 * Watched (per directory, non-recursive — recursive fs.watch is unavailable
 * on Linux under the Node 18 extension host):
 *   <common>              packed-refs / HEAD / ORIG_HEAD writes
 *   <common>/refs/**      loose ref updates (branch tips)
 *   <common>/logs/**      reflog appends — commits, amends, rebases, resets
 *   <common>/worktrees/** worktree add/remove + each linked worktree's HEAD
 *
 * objects/ is deliberately never watched. Git ops are bursty and write via
 * rename, so events are debounced; directory sets change (new branch
 * namespaces, new worktrees), so every burst also triggers a rescan that
 * adds/removes per-directory watchers. Callers keep a slow poll as fallback
 * for filesystems that drop events (NFS, some Docker mounts).
 */

const DEBOUNCE_MS = 300;
/** Safety valve — refs/logs/worktrees dir counts are tiny in practice. */
const MAX_DIRS = 512;

export class GitDirWatcher {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private debounce: NodeJS.Timeout | undefined;
  private rescanning = false;
  private rescanQueued = false;
  private disposed = false;

  constructor(
    private readonly commonDir: string,
    private readonly onChange: () => void,
    private readonly output?: { appendLine(value: string): void },
  ) {}

  /** True once at least one directory is being watched. */
  get active(): boolean {
    return this.watchers.size > 0;
  }

  async start(): Promise<boolean> {
    await this.rescan();
    return this.active;
  }

  private async collectDirs(): Promise<Set<string>> {
    const found = new Set<string>();
    const common = path.normalize(this.commonDir);
    // The common dir itself is watched but never recursed (objects/ lives there)
    try {
      await fsp.access(common);
      found.add(common);
    } catch {
      return found;
    }
    const stack = [
      path.join(common, 'refs'),
      path.join(common, 'logs'),
      path.join(common, 'worktrees'),
    ];
    while (stack.length > 0 && found.size < MAX_DIRS) {
      const dir = path.normalize(stack.pop()!);
      if (found.has(dir)) continue;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // absent (e.g. no worktrees/ yet) — rescan picks it up later
      }
      found.add(dir);
      for (const e of entries) {
        if (e.isDirectory()) stack.push(path.join(dir, e.name));
      }
    }
    return found;
  }

  /** Reconcile per-directory watchers with the current directory set. */
  private async rescan(): Promise<void> {
    if (this.disposed || this.rescanning) {
      this.rescanQueued = this.rescanning;
      return;
    }
    this.rescanning = true;
    try {
      const dirs = await this.collectDirs();
      for (const [dir, watcher] of [...this.watchers]) {
        if (!dirs.has(dir)) {
          watcher.close();
          this.watchers.delete(dir);
        }
      }
      for (const dir of dirs) {
        if (this.watchers.has(dir)) continue;
        try {
          const watcher = fs.watch(dir, () => this.handleEvent());
          watcher.on('error', () => {
            watcher.close();
            this.watchers.delete(dir);
            this.queueRescan();
          });
          this.watchers.set(dir, watcher);
        } catch {
          // dir vanished between readdir and watch — rescan reconciles
        }
      }
    } finally {
      this.rescanning = false;
      if (this.rescanQueued && !this.disposed) {
        this.rescanQueued = false;
        void this.rescan();
      }
    }
  }

  private queueRescan(): void {
    void this.rescan();
  }

  private handleEvent(): void {
    if (this.disposed) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      // Reconcile watchers first (new branch dirs / worktrees), then notify
      void this.rescan().finally(() => {
        if (!this.disposed) {
          try {
            this.onChange();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.output?.appendLine(`.git watch callback failed: ${message}`);
          }
        }
      });
    }, DEBOUNCE_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}
