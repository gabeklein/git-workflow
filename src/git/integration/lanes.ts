import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { git, gitOk } from '../exec';
import { integrationBranch } from './config';

export const APPLIED_FILE = 'focus-applied';
export const CANDIDATES_FILE = 'focus-candidates';
const WIP_FILE = 'focus-wip';
const EXCLUDED_FILE = 'focus-excluded';
export const LOCK_DIR = 'focus-working.lock';

export async function commonDir(cwd: string): Promise<string> {
  const out = (await git(cwd, ['rev-parse', '--git-common-dir'])).trim();
  return path.resolve(cwd, out);
}

export async function readLaneFile(cwd: string, file: string): Promise<string[]> {
  const abs = path.join(await commonDir(cwd), file);
  let raw: string;
  try {
    raw = await fs.readFile(abs, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * `ordered` files keep the order they were written in; the rest are sets
 * and get sorted for a stable diff.
 *
 * focus-applied is ordered, and that is load-bearing: lanes merge in file
 * order, so the order they were INCLUDED is the order they merge. Sorting
 * it made merge order alphabetical, which sounds harmless until the
 * conflict resolver fires — union inserts land in merge order, and
 * best-effort resolves same-line clashes toward the incoming lane. Under a
 * sort, which lane wins was decided by branch NAME, and renaming a branch
 * silently changed the preview.
 */
export async function writeLaneFile(
  cwd: string,
  file: string,
  lanes: string[],
  opts: { ordered?: boolean } = {},
): Promise<void> {
  const abs = path.join(await commonDir(cwd), file);
  const unique = [...new Set(lanes.filter(Boolean))];
  const out = opts.ordered ? unique : unique.sort();
  await fs.writeFile(abs, out.length > 0 ? `${out.join('\n')}\n` : '');
}

export async function listAppliedLanes(cwd: string): Promise<string[]> {
  return readLaneFile(cwd, APPLIED_FILE);
}

export async function addAppliedLane(cwd: string, lane: string): Promise<void> {
  const lanes = await listAppliedLanes(cwd);
  if (!lanes.includes(lane)) {
    lanes.push(lane);
    await writeLaneFile(cwd, APPLIED_FILE, lanes, { ordered: true });
  }
}

export async function dropAppliedLane(
  cwd: string,
  lane: string,
): Promise<void> {
  const lanes = await listAppliedLanes(cwd);
  await writeLaneFile(
    cwd,
    APPLIED_FILE,
    lanes.filter((l) => l !== lane),
    { ordered: true },
  );
}

/** Candidates: lanes shown (checkable) under the Integration row. */
export async function listCandidateLanes(cwd: string): Promise<string[]> {
  return readLaneFile(cwd, CANDIDATES_FILE);
}

export async function addCandidateLane(
  cwd: string,
  lane: string,
): Promise<void> {
  const lanes = await listCandidateLanes(cwd);
  if (!lanes.includes(lane)) {
    lanes.push(lane);
    await writeLaneFile(cwd, CANDIDATES_FILE, lanes);
  }
}

export async function dropCandidateLane(
  cwd: string,
  lane: string,
): Promise<void> {
  const lanes = await listCandidateLanes(cwd);
  await writeLaneFile(
    cwd,
    CANDIDATES_FILE,
    lanes.filter((l) => l !== lane),
  );
}

/**
 * Base pin: the sha integration rebuilds are FROZEN to. Written on enable
 * and kept across reloads; the effective base follows origin/<base> when
 * that is a descendant of the pin (published movement is always legit)
 * and holds the pin otherwise — so commits made directly on the local
 * base branch never silently retarget the preview. Catch Up Integration
 * Base advances the pin deliberately.
 */
const BASE_PIN_FILE = 'focus-base';

export async function readBasePin(cwd: string): Promise<string | undefined> {
  const lines = await readLaneFile(cwd, BASE_PIN_FILE);
  const sha = lines[0]?.trim();
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
}

export async function writeBasePin(cwd: string, sha: string): Promise<void> {
  await writeLaneFile(cwd, BASE_PIN_FILE, [sha]);
}

export async function clearBasePin(cwd: string): Promise<void> {
  await writeLaneFile(cwd, BASE_PIN_FILE, []);
}

/**
 * Exclusions: branches the user removed from Integration that would
 * otherwise auto-enroll (their base matches the integration base). This
 * is what gives every auto row a real exit — Remove persists here instead
 * of the row reappearing on the next refresh.
 */
export async function listExcludedLanes(cwd: string): Promise<string[]> {
  return readLaneFile(cwd, EXCLUDED_FILE);
}

export async function addExcludedLane(
  cwd: string,
  lane: string,
): Promise<void> {
  const lanes = await listExcludedLanes(cwd);
  if (!lanes.includes(lane)) {
    lanes.push(lane);
    await writeLaneFile(cwd, EXCLUDED_FILE, lanes);
  }
}

export async function dropExcludedLane(
  cwd: string,
  lane: string,
): Promise<void> {
  const lanes = await listExcludedLanes(cwd);
  await writeLaneFile(
    cwd,
    EXCLUDED_FILE,
    lanes.filter((l) => l !== lane),
  );
}

/**
 * Prune dead lanes: a branch deleted out from under Integration (its
 * worktree died — landed and cleaned up, agent teardown, `git branch -D`)
 * must not linger as a ghost row. Drops every lane whose local branch no
 * longer exists from all four state files. The applied file is shared
 * with the shell script and only changes under the rebuild lock, so the
 * writes happen inside it; when the lock is already held, nothing is
 * pruned this round and the next refresh retries. Returns the pruned
 * lane names.
 */
export async function pruneDeadLanes(cwd: string): Promise<string[]> {
  const files = [APPLIED_FILE, CANDIDATES_FILE, WIP_FILE, EXCLUDED_FILE];
  const named = [
    ...new Set((await Promise.all(files.map((f) => readLaneFile(cwd, f)))).flat()),
  ];
  const dead: string[] = [];
  for (const lane of named) {
    if (
      !(await gitOk(cwd, ['rev-parse', '-q', '--verify', `refs/heads/${lane}`]))
    ) {
      dead.push(lane);
    }
  }
  if (dead.length === 0) {
    return [];
  }
  const lock = path.join(await commonDir(cwd), LOCK_DIR);
  try {
    await fs.mkdir(lock);
  } catch {
    return [];
  }
  try {
    for (const file of files) {
      // Re-read under the lock — a rebuild may have rewritten the file
      const lanes = await readLaneFile(cwd, file);
      const kept = lanes.filter((l) => !dead.includes(l));
      if (kept.length !== lanes.length) {
        await writeLaneFile(cwd, file, kept, {
          ordered: file === APPLIED_FILE,
        });
      }
    }
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
  return dead.sort();
}

/**
 * Block accidental `git push` while on the integration branch: point its
 * pushRemote at a remote that does not exist. Plain `git push` (simple/
 * current/upstream push.default) fails fast; an explicit
 * `git push origin <branch>` still works as the escape hatch. Repo-local,
 * so it covers every terminal/agent in the clone, not just the extension.
 */

export async function ensureIntegrationPushBlocked(
  cwd: string,
  branch = integrationBranch(),
): Promise<void> {
  const key = `branch.${branch}.pushRemote`;
  let current = '';
  try {
    current = (await git(cwd, ['config', '--get', key])).trim();
  } catch {
    // unset
  }
  if (current !== 'no_push') {
    await git(cwd, ['config', key, 'no_push']);
  }
}

/** Lanes whose *uncommitted* worktree edits overlay into the rebuild. */

export async function listWipLanes(cwd: string): Promise<string[]> {
  return readLaneFile(cwd, WIP_FILE);
}

export async function setWipLane(
  cwd: string,
  lane: string,
  enabled: boolean,
): Promise<void> {
  const lanes = await listWipLanes(cwd);
  if (enabled && !lanes.includes(lane)) {
    lanes.push(lane);
    await writeLaneFile(cwd, WIP_FILE, lanes);
  } else if (!enabled && lanes.includes(lane)) {
    await writeLaneFile(
      cwd,
      WIP_FILE,
      lanes.filter((l) => l !== lane),
    );
  }
}
