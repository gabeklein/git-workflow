import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { git } from './exec';

/**
 * "Look again, now."
 *
 * The editor learns about git activity from an fs.watch on the common dir,
 * so anything an agent does with refs — commit, branch, rebase, worktree
 * add — reaches the sidebar within a debounce and needs no help. Two
 * things do not: edits that never touch `.git` (a dirty worktree is state
 * on disk nowhere near it), and filesystems that drop watch events. Both
 * fall back to a 30-second poll, which is a long time to sit looking at a
 * row that disagrees with the terminal beside it.
 *
 * So this is a deliberate event source: a file whose CONTENT is never read
 * and whose only purpose is to have been written. Nothing answers it — a
 * signal is not a request, and there is nobody to ask.
 *
 * The extension recognises the stamp rather than merely waking on it: a
 * watch event alone refreshes the views that listen for activity, but the
 * worktree ROWS come from discovery, which only reruns when membership
 * changes. Without that recognition, "refresh" would leave the one thing
 * an agent is most likely to want refreshed — its own dirty row — exactly
 * as stale as before.
 */

export const REFRESH_FILE = 'focus-refresh';

async function commonDirOf(cwd: string): Promise<string> {
  const out = (await git(cwd, ['rev-parse', '--git-common-dir'])).trim();
  return path.resolve(cwd, out);
}

/** Ask any editor watching this repo to catch up. */
export async function signalRefresh(cwd: string): Promise<void> {
  const file = path.join(await commonDirOf(cwd), REFRESH_FILE);
  await fs.writeFile(file, `${new Date().toISOString()}\n`);
}

/**
 * The stamp, for a watcher deciding whether this is a new request. mtime
 * rather than the contents: the file is a signal, and a caller that writes
 * the same bytes twice still means it twice.
 */
export async function refreshStamp(common: string): Promise<number | undefined> {
  try {
    return (await fs.stat(path.join(common, REFRESH_FILE))).mtimeMs;
  } catch {
    return undefined;
  }
}
