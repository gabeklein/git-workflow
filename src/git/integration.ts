import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { git, GitError, gitOk } from './exec';

/**
 * Integration-worktree overlay (interop with agent-focus's
 * scripts/focus-working.sh): a worktree checked out on the integration
 * branch is never worked in directly — it is rebuilt as <base> plus a
 * --no-ff merge of each "applied" lane (feature branch).
 *
 * Shared on-disk protocol (same files the shell script / post-commit
 * hook use, so both can coexist):
 *   <git-common-dir>/focus-applied       one lane per line, # comments
 *   <git-common-dir>/focus-working.lock  mkdir lock around rebuilds
 */

const APPLIED_FILE = 'focus-applied';
const LOCK_DIR = 'focus-working.lock';

export function integrationBranch(): string {
  return (
    vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<string>('integrationBranch', 'focus/working')
      .trim() || 'focus/working'
  );
}

export function isIntegrationAutoRebuildEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<boolean>('integrationAutoRebuild', true);
}

/** Branches that must never be applied as a lane. */
export function isLaneBranch(branch: string, baseRef: string): boolean {
  if (!branch || branch === 'HEAD' || branch === 'unknown') {
    return false;
  }
  const blocked = new Set([
    'main',
    'master',
    integrationBranch(),
    baseRef.replace(/^origin\//, ''),
  ]);
  return !blocked.has(branch) && !branch.startsWith('gitbutler/');
}

async function commonDir(cwd: string): Promise<string> {
  const out = (await git(cwd, ['rev-parse', '--git-common-dir'])).trim();
  return path.resolve(cwd, out);
}

export async function listAppliedLanes(cwd: string): Promise<string[]> {
  const file = path.join(await commonDir(cwd), APPLIED_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

async function saveAppliedLanes(cwd: string, lanes: string[]): Promise<void> {
  const file = path.join(await commonDir(cwd), APPLIED_FILE);
  const unique = [...new Set(lanes.filter(Boolean))].sort();
  await fs.writeFile(file, unique.length > 0 ? `${unique.join('\n')}\n` : '');
}

export async function addAppliedLane(cwd: string, lane: string): Promise<void> {
  const lanes = await listAppliedLanes(cwd);
  if (!lanes.includes(lane)) {
    lanes.push(lane);
    await saveAppliedLanes(cwd, lanes);
  }
}

export async function dropAppliedLane(
  cwd: string,
  lane: string,
): Promise<void> {
  const lanes = await listAppliedLanes(cwd);
  await saveAppliedLanes(
    cwd,
    lanes.filter((l) => l !== lane),
  );
}

export type RebuildResult =
  | { ok: true; lanes: string[]; skipped: string[] }
  | {
      ok: false;
      code: 'busy' | 'dirty' | 'unique' | 'conflict' | 'error';
      message: string;
      lane?: string;
    };

async function resolveBaseSha(
  cwd: string,
  baseRef: string,
): Promise<string | undefined> {
  const name = baseRef.replace(/^origin\//, '');
  for (const ref of [`refs/heads/${name}`, `origin/${name}`, baseRef]) {
    try {
      return (await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    } catch {
      // try next
    }
  }
  return undefined;
}

/**
 * Rebuild the integration worktree: reset --hard to base, then merge each
 * applied lane with --no-ff. Refuses when the tree is dirty or carries
 * commits that belong to no lane; a merge conflict leaves the tree in
 * place (resolve there or Abort Integration Merge).
 */
export async function rebuildIntegration(
  workingPath: string,
  baseRef: string,
): Promise<RebuildResult> {
  const common = await commonDir(workingPath);
  const lock = path.join(common, LOCK_DIR);
  try {
    await fs.mkdir(lock);
  } catch {
    return {
      ok: false,
      code: 'busy',
      message: 'another rebuild holds the lock (focus-working.lock)',
    };
  }

  try {
    const porcelain = await git(workingPath, [
      'status',
      '--porcelain=v1',
      '-unormal',
      '--ignore-submodules=dirty',
    ]);
    if (porcelain.trim().length > 0) {
      return {
        ok: false,
        code: 'dirty',
        message: 'integration worktree is dirty; not rebuilding',
      };
    }

    const lanes = await listAppliedLanes(workingPath);
    const baseSha = await resolveBaseSha(workingPath, baseRef);
    if (!baseSha) {
      return {
        ok: false,
        code: 'error',
        message: `base ref ${baseRef} does not resolve`,
      };
    }

    // Unique-commit guard: nothing on HEAD may be outside base + lanes
    const not = [baseSha, ...lanes];
    const unique = (
      await git(workingPath, [
        'rev-list',
        '--no-merges',
        'HEAD',
        '--not',
        ...not,
      ]).catch(() => '')
    ).trim();
    if (unique) {
      return {
        ok: false,
        code: 'unique',
        message:
          'integration worktree has unique commits; move them to a feature branch first',
      };
    }

    await git(workingPath, ['reset', '--hard', baseSha]);

    const skipped: string[] = [];
    const merged: string[] = [];
    for (const lane of lanes) {
      if (
        !(await gitOk(workingPath, [
          'rev-parse',
          '--verify',
          `refs/heads/${lane}`,
        ]))
      ) {
        skipped.push(lane);
        continue;
      }
      try {
        await git(workingPath, [
          'merge',
          '--no-edit',
          '--no-ff',
          '-m',
          `${integrationBranch()}: ${lane}`,
          lane,
        ]);
        merged.push(lane);
      } catch (err) {
        const message =
          err instanceof GitError
            ? err.stderr.trim() || err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return { ok: false, code: 'conflict', message, lane };
      }
    }
    return { ok: true, lanes: merged, skipped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'error', message };
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}

/**
 * Enable the overlay: create a worktree on the integration branch.
 * Reuses the branch when it already exists; otherwise branches off base.
 */
export async function createIntegrationWorktree(
  repoCwd: string,
  destDir: string,
  baseRef: string,
): Promise<void> {
  const branch = integrationBranch();
  if (await gitOk(repoCwd, ['rev-parse', '--verify', `refs/heads/${branch}`])) {
    await git(repoCwd, ['worktree', 'add', destDir, branch]);
    return;
  }
  const baseSha = await resolveBaseSha(repoCwd, baseRef);
  if (!baseSha) {
    throw new Error(`base ref ${baseRef} does not resolve`);
  }
  await git(repoCwd, ['worktree', 'add', '-b', branch, destDir, baseSha]);
}

export async function abortIntegrationMerge(
  workingPath: string,
): Promise<void> {
  await git(workingPath, ['merge', '--abort']);
}

/**
 * Change signal for auto-rebuild: base + applied lane tips. When this
 * moves, the integration tree is stale. The integration worktree's own
 * HEAD is deliberately excluded (the rebuild itself moves it).
 */
export async function integrationFingerprint(
  cwd: string,
  baseRef: string,
): Promise<string> {
  const lanes = await listAppliedLanes(cwd);
  const parts: string[] = [`base\0${await resolveBaseSha(cwd, baseRef)}`];
  for (const lane of lanes) {
    let sha = '';
    try {
      sha = (
        await git(cwd, ['rev-parse', '--verify', `refs/heads/${lane}^{commit}`])
      ).trim();
    } catch {
      sha = 'missing';
    }
    parts.push(`${lane}\0${sha}`);
  }
  return parts.join('\n');
}
