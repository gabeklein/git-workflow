import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The one lock, and who is holding it.
 *
 * Every writer of the preview takes this: the engine across a whole
 * rebuild, a membership change across its read-modify-write, the shell
 * script across its own edits. That has always been the correctness
 * boundary — what it lacked was an ANSWER. A bare `mkdir` lock cannot say
 * whether a repo is busy or wedged, so a process killed mid-rebuild left a
 * directory that made every later `gw-lane add` wait ten seconds and fail,
 * with nothing to point at.
 *
 * So the lock carries its holder: pid, host, what it is doing. Two things
 * follow, and they are the whole reason this file exists —
 *
 *   - "would the preview move under me?" is answerable (`gw-lane owner`);
 *   - a lock whose owner died on THIS host is swept rather than waited on.
 *
 * Never swept across hosts. Signal 0 tells us about our own process table
 * and nothing about anyone else's, and guessing wrong means two writers in
 * a checkout that is about to be `reset --hard`.
 */

export const LOCK_DIR = 'focus-working.lock';
const OWNER_FILE = 'owner';

export interface LockOwner {
  pid: number;
  host: string;
  started: string;
  /** What the holder is doing, for anyone who has to wait on it. */
  op: string;
}

function lockPaths(common: string): { dir: string; owner: string } {
  const dir = path.join(common, LOCK_DIR);
  return { dir, owner: path.join(dir, OWNER_FILE) };
}

export async function readLockOwner(
  common: string,
): Promise<LockOwner | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPaths(common).owner, 'utf8');
  } catch {
    return undefined;
  }
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const pid = Number(values.get('pid'));
  if (!pid) return undefined;
  return {
    pid,
    host: values.get('host') ?? '',
    started: values.get('started') ?? '',
    op: values.get('op') ?? '',
  };
}

export type Liveness = 'none' | 'alive' | 'dead' | 'unknown';

export function ownerLiveness(owner: LockOwner | undefined): Liveness {
  if (!owner) return 'none';
  if (owner.host !== os.hostname()) return 'unknown';
  try {
    process.kill(owner.pid, 0);
    return 'alive';
  } catch (err) {
    // EPERM: it exists and belongs to somebody else — alive for our purposes
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : 'dead';
  }
}

/**
 * Take the lock, or report that somebody has it. One sweep of a dead
 * same-host owner, then one retry — a second failure means a live holder
 * or a race with another taker, both of which are answered by waiting.
 */
export async function acquireLaneLock(
  common: string,
  op: string,
): Promise<boolean> {
  const { dir, owner } = lockPaths(common);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.mkdir(dir);
    } catch {
      if (attempt > 0) return false;
      if (ownerLiveness(await readLockOwner(common)) !== 'dead') return false;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    // Best-effort: the lock is held by the directory's existence, and a
    // holder that cannot write its name is still a holder.
    await fs
      .writeFile(
        owner,
        [
          `pid: ${process.pid}`,
          `host: ${os.hostname()}`,
          `started: ${new Date().toISOString()}`,
          `op: ${op}`,
          '',
        ].join('\n'),
      )
      .catch(() => {});
    return true;
  }
  return false;
}

export async function releaseLaneLock(common: string): Promise<void> {
  await fs
    .rm(lockPaths(common).dir, { recursive: true, force: true })
    .catch(() => {});
}

/**
 * How long a writer waits for the lock before giving up.
 *
 * Generous on purpose. The holder is usually a rebuild, and a rebuild is
 * "a few seconds" only on a developer's machine: under CI, on a cold cache,
 * with several lanes and a landed probe, it runs well past ten seconds —
 * which is what the first value here was, and it turned an ordinary
 * `gw-lane add` issued during a rebuild into a hard failure. Queuing behind
 * a rebuild is the normal case, not an error.
 *
 * Bounded rather than infinite so a wedged repo still returns something an
 * agent can report, and the answer when it runs out is "could not run"
 * (exit 2), never "the preview is broken".
 */
const LOCK_WAIT_MS = 60_000;

/**
 * Run `fn` holding the lock, waiting for it rather than failing. Returns
 * undefined when the wait ran out.
 */
export async function withLaneLock<T>(
  common: string,
  op: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<T | undefined> {
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  while (!(await acquireLaneLock(common, op))) {
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    return await fn();
  } finally {
    await releaseLaneLock(common);
  }
}
