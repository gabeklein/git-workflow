import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { git } from '../exec';
import { integrationBranch } from './config';

export const APPLIED_FILE = 'focus-applied';
export const CANDIDATES_FILE = 'focus-candidates';
const WIP_FILE = 'focus-wip';
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

export async function writeLaneFile(
  cwd: string,
  file: string,
  lanes: string[],
): Promise<void> {
  const abs = path.join(await commonDir(cwd), file);
  const unique = [...new Set(lanes.filter(Boolean))].sort();
  await fs.writeFile(abs, unique.length > 0 ? `${unique.join('\n')}\n` : '');
}

export async function listAppliedLanes(cwd: string): Promise<string[]> {
  return readLaneFile(cwd, APPLIED_FILE);
}

export async function addAppliedLane(cwd: string, lane: string): Promise<void> {
  const lanes = await listAppliedLanes(cwd);
  if (!lanes.includes(lane)) {
    lanes.push(lane);
    await writeLaneFile(cwd, APPLIED_FILE, lanes);
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
 * Block accidental `git push` while on the integration branch: point its
 * pushRemote at a remote that does not exist. Plain `git push` (simple/
 * current/upstream push.default) fails fast; an explicit
 * `git push origin <branch>` still works as the escape hatch. Repo-local,
 * so it covers every terminal/agent in the clone, not just the extension.
 */

export async function ensureIntegrationPushBlocked(cwd: string): Promise<void> {
  const branch = integrationBranch();
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
