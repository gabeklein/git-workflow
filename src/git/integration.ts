import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureExcludedFromStatus } from './exclude';
import { git, GitError, gitOk } from './exec';
import { listWorktreeAdmin } from './worktreeAdmin';

/**
 * Integration-worktree overlay (interop with agent-focus's
 * scripts/focus-working.sh): a checkout on the integration branch is never
 * worked in directly — it is rebuilt as <base> plus a merge of each
 * "applied" lane (feature branch). Lanes merge landed commits only; dirty
 * feature worktrees never affect the integration tree.
 *
 * The merge chain is computed OFF-TREE (`git merge-tree --write-tree` +
 * `commit-tree`), then applied with a single `reset --hard`, so:
 *   - a conflicting lane never leaves the checkout mid-merge, and
 *   - a running dev server sees one burst of only the files that changed.
 *
 * Shared on-disk protocol (same files the shell script / post-commit
 * hook use, so both can coexist):
 *   <git-common-dir>/focus-applied       applied lanes, one per line
 *   <git-common-dir>/focus-candidates    lanes offered in the UI (superset)
 *   <git-common-dir>/focus-working.lock  mkdir lock around rebuilds
 */

const APPLIED_FILE = 'focus-applied';
const CANDIDATES_FILE = 'focus-candidates';
const WIP_FILE = 'focus-wip';
const LOCK_DIR = 'focus-working.lock';
/** Subject prefix marking ephemeral working-tree snapshot commits. */
const WIP_SUBJECT = 'wip(gw):';
let wipIndexCounter = 0;

export function integrationBranch(): string {
  const template =
    vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<string>('integrationBranch', 'integration/{base}')
      .trim() || 'integration/{base}';
  // {base} → short base name (origin/main → main)
  return template.replace(
    '{base}',
    integrationBaseRef().replace(/^origin\//, ''),
  );
}

export function isIntegrationAutoRebuildEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<boolean>('integrationAutoRebuild', true);
}

/**
 * Base ref for integration rebuilds: integrationBaseRef when set,
 * else defaultBaseRef. Kept separate so changing the integration base
 * (header context menu) does not affect compare-base fallbacks.
 */
export function integrationBaseRef(): string {
  const config = vscode.workspace.getConfiguration('worktreeCompare');
  const dedicated = config.get<string>('integrationBaseRef', '').trim();
  return dedicated || config.get<string>('defaultBaseRef', 'main');
}

export type AutoResolveMode = 'off' | 'whitespace' | 'lane-wins';

/**
 * How far a lane merge may auto-resolve clashes. Non-overlapping hunks in
 * the same file always merge — git does that by default. This governs the
 * rest: 'whitespace' resolves formatting-only clashes; 'lane-wins' resolves
 * every text clash toward the incoming lane (covers adjacent-line edits,
 * at the cost of possibly dropping the other side's neighboring edit).
 */
export function integrationAutoResolve(): AutoResolveMode {
  const v = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<string>('integrationAutoResolve', 'whitespace');
  return v === 'off' || v === 'lane-wins' ? v : 'whitespace';
}

function autoResolveArgs(): string[] {
  switch (integrationAutoResolve()) {
    case 'lane-wins':
      // theirs implies whitespace clashes resolve too
      return ['-X', 'theirs', '-X', 'ignore-space-change'];
    case 'whitespace':
      return ['-X', 'ignore-space-change'];
    default:
      return [];
  }
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

async function readLaneFile(cwd: string, file: string): Promise<string[]> {
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

async function writeLaneFile(
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

/**
 * Snapshot a lane worktree's uncommitted state (staged + unstaged +
 * untracked, gitignore respected) as an ephemeral commit on top of its
 * HEAD — via a temporary index, so the lane's real index, HEAD, and
 * branch are untouched. Returns undefined when the worktree is clean.
 */
export async function snapshotWorktreeCommit(
  lanePath: string,
  lane: string,
): Promise<string | undefined> {
  const common = await commonDir(lanePath);
  const tmpIndex = path.join(
    common,
    `focus-wip-index-${process.pid}-${wipIndexCounter++}`,
  );
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(lanePath, ['read-tree', 'HEAD'], env);
    await git(lanePath, ['add', '-A'], env);
    const tree = (await git(lanePath, ['write-tree'], env)).trim();
    const headTree = (
      await git(lanePath, ['rev-parse', 'HEAD^{tree}'])
    ).trim();
    if (tree === headTree) {
      return undefined; // clean — merge the branch tip as usual
    }
    return (
      await git(lanePath, [
        'commit-tree',
        tree,
        '-p',
        'HEAD',
        '-m',
        `${WIP_SUBJECT} ${lane}`,
      ])
    ).trim();
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => {});
  }
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
 * Merge two commits without touching any working tree.
 * Returns the merged tree oid, a conflict (with the files), or
 * 'unsupported' when git predates merge-tree --write-tree (< 2.38).
 */
async function mergeOffTree(
  cwd: string,
  ours: string,
  theirs: string,
): Promise<
  | { kind: 'tree'; tree: string }
  | { kind: 'conflict'; files: string[] }
  | { kind: 'unsupported' }
> {
  try {
    const out = await git(cwd, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      ...autoResolveArgs(),
      ours,
      theirs,
    ]);
    return { kind: 'tree', tree: out.trim().split('\n')[0]!.trim() };
  } catch (err) {
    if (err instanceof GitError) {
      // Exit 1 = clean run, conflicts found. Stdout sections are separated
      // by a blank line: oid, conflicted file names, informational messages.
      if (err.code === 1 && err.stdout.trim()) {
        const lines = err.stdout.split('\n').map((l) => l.trim());
        const files: string[] = [];
        for (const line of lines.slice(1)) {
          if (!line) {
            break;
          }
          files.push(line);
        }
        return { kind: 'conflict', files };
      }
      if (
        err.stderr.includes('usage:') ||
        err.stderr.includes('--write-tree') ||
        err.code === 129
      ) {
        return { kind: 'unsupported' };
      }
    }
    throw err;
  }
}

/**
 * Rebuild the integration checkout: compute base + `--no-ff`-style merge
 * of each applied lane off-tree, then apply the result with one
 * `reset --hard`. Refuses when the checkout is dirty or carries commits
 * that belong to no lane. A conflicting lane fails the rebuild WITHOUT
 * touching the working tree.
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
    // Recover from a mid-merge state left by the shell script / old engine.
    // The tree is derived, so aborting is always safe.
    if (await gitOk(workingPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
      await git(workingPath, ['merge', '--abort']);
    }

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
        message: 'integration checkout is dirty; not rebuilding',
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

    // Unique-commit guard: refuse only when HEAD carries non-merge commits
    // that exist on NO other branch — i.e. work that would truly be lost.
    // Commits from formerly-applied lanes still live on their branches, and
    // ephemeral wip snapshots (ours, by subject marker) are derived state.
    const unique = (
      await git(workingPath, [
        'log',
        '--no-merges',
        '--format=%H%x00%s',
        'HEAD',
        '--not',
        baseSha,
        `--exclude=${integrationBranch()}`,
        '--branches',
      ]).catch(() => '')
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !(l.split('\0')[1] ?? '').startsWith(WIP_SUBJECT))
      .join('\n');
    if (unique) {
      return {
        ok: false,
        code: 'unique',
        message:
          'integration checkout has commits that exist on no other branch; move them to a feature branch first',
      };
    }

    // Wip lanes: overlay uncommitted worktree edits via ephemeral snapshots
    const wipLanes = new Set(
      (await listWipLanes(workingPath).catch(() => [])).filter((l) =>
        lanes.includes(l),
      ),
    );
    const laneCheckouts = new Map<string, string>();
    if (wipLanes.size > 0) {
      try {
        const admin = await listWorktreeAdmin(workingPath);
        for (const state of admin.values()) {
          if (state.branch) {
            laneCheckouts.set(state.branch, state.path);
          }
        }
      } catch {
        // no lookup — wip lanes fall back to branch tips
      }
    }

    // Compute the whole chain off-tree, then apply once
    let current = baseSha;
    const skipped: string[] = [];
    const merged: string[] = [];
    for (const lane of lanes) {
      let laneSha: string;
      try {
        laneSha = (
          await git(workingPath, [
            'rev-parse',
            '--verify',
            `refs/heads/${lane}^{commit}`,
          ])
        ).trim();
      } catch {
        skipped.push(lane);
        continue;
      }
      if (wipLanes.has(lane)) {
        const checkout = laneCheckouts.get(lane);
        if (checkout) {
          try {
            const snapshot = await snapshotWorktreeCommit(checkout, lane);
            if (snapshot) {
              laneSha = snapshot;
            }
          } catch {
            // snapshot failed — merge the branch tip instead
          }
        }
      }
      // Lane already contained in the chain (e.g. no commits yet): nothing
      // to merge — and commit-tree would collapse duplicate parents into a
      // non-merge commit that trips the unique guard.
      if (
        laneSha === current ||
        (await gitOk(workingPath, [
          'merge-base',
          '--is-ancestor',
          laneSha,
          current,
        ]))
      ) {
        merged.push(lane);
        continue;
      }
      const result = await mergeOffTree(workingPath, current, laneSha);
      if (result.kind === 'unsupported') {
        return rebuildInWorktree(workingPath, baseSha, lanes);
      }
      if (result.kind === 'conflict') {
        const files = result.files.slice(0, 5).join(', ');
        return {
          ok: false,
          code: 'conflict',
          lane,
          message: `lane ${lane} conflicts${files ? `: ${files}` : ''}${
            result.files.length > 5 ? ', …' : ''
          } (checkout untouched)`,
        };
      }
      current = (
        await git(workingPath, [
          'commit-tree',
          result.tree,
          '-p',
          current,
          '-p',
          laneSha,
          '-m',
          `${integrationBranch()}: ${lane}`,
        ])
      ).trim();
      merged.push(lane);
    }

    // Single working-tree update; git rewrites only files whose content changed
    await git(workingPath, ['reset', '--hard', current]);
    return { ok: true, lanes: merged, skipped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'error', message };
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}

/** Legacy path for git < 2.38 (no merge-tree --write-tree): merge in-tree. */
async function rebuildInWorktree(
  workingPath: string,
  baseSha: string,
  lanes: string[],
): Promise<RebuildResult> {
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
        ...autoResolveArgs(),
        '-m',
        `${integrationBranch()}: ${lane}`,
        lane,
      ]);
      merged.push(lane);
    } catch (err) {
      // Leave nothing half-merged on this fallback path either
      await git(workingPath, ['merge', '--abort']).catch(() => {});
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
}

/**
 * Enable the overlay in a separate worktree: create one on the integration
 * branch. Reuses the branch when it already exists; else branches off base.
 */
export async function createIntegrationWorktree(
  repoCwd: string,
  destDir: string,
  baseRef: string,
): Promise<void> {
  const branch = integrationBranch();
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  // Repo-local ignore before creation, so status never flashes dirty
  await ensureExcludedFromStatus(destDir).catch(() => undefined);
  if (await gitOk(repoCwd, ['rev-parse', '--verify', `refs/heads/${branch}`])) {
    await git(repoCwd, ['worktree', 'add', destDir, branch]);
  } else {
    const baseSha = await resolveBaseSha(repoCwd, baseRef);
    if (!baseSha) {
      throw new Error(`base ref ${baseRef} does not resolve`);
    }
    await git(repoCwd, ['worktree', 'add', '-b', branch, destDir, baseSha]);
  }
  await ensureIntegrationPushBlocked(repoCwd);
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const out = (
      await git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'])
    ).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Enable the overlay on an existing checkout (usually the workspace root):
 * switch it to the integration branch. Requires a clean tree — the caller
 * checks and reports. Returns the branch that was checked out before.
 */
export async function switchToIntegrationBranch(
  checkoutPath: string,
  baseRef: string,
): Promise<string | undefined> {
  const branch = integrationBranch();
  const previous = await currentBranch(checkoutPath);
  if (
    await gitOk(checkoutPath, ['rev-parse', '--verify', `refs/heads/${branch}`])
  ) {
    try {
      await git(checkoutPath, ['switch', branch]);
    } catch (err) {
      const stderr = err instanceof GitError ? err.stderr : '';
      if (stderr.includes('already used by worktree')) {
        throw new Error(
          `${branch} is already checked out in another worktree — integration mode is on there`,
        );
      }
      throw err;
    }
    await ensureIntegrationPushBlocked(checkoutPath);
    return previous;
  }
  const baseSha = await resolveBaseSha(checkoutPath, baseRef);
  if (!baseSha) {
    throw new Error(`base ref ${baseRef} does not resolve`);
  }
  await git(checkoutPath, ['switch', '-c', branch, baseSha]);
  await ensureIntegrationPushBlocked(checkoutPath);
  return previous;
}

/**
 * Disable on a checkout that must stay: leave the integration branch.
 * The tree is derived, so any local state is discarded first.
 */
export async function switchAwayFromIntegration(
  checkoutPath: string,
  returnBranch: string | undefined,
  baseRef: string,
): Promise<string> {
  if (await gitOk(checkoutPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
    await git(checkoutPath, ['merge', '--abort']).catch(() => {});
  }
  await git(checkoutPath, ['reset', '--hard']);
  const fallback = baseRef.replace(/^origin\//, '');
  for (const target of [returnBranch, fallback]) {
    if (!target || target === integrationBranch()) {
      continue;
    }
    if (
      await gitOk(checkoutPath, [
        'rev-parse',
        '--verify',
        `refs/heads/${target}`,
      ])
    ) {
      await git(checkoutPath, ['switch', target]);
      return target;
    }
  }
  // Last resort: detach at base so the checkout leaves the derived branch
  const baseSha = await resolveBaseSha(checkoutPath, baseRef);
  if (!baseSha) {
    throw new Error(`no branch to return to and ${baseRef} does not resolve`);
  }
  await git(checkoutPath, ['switch', '--detach', baseSha]);
  return baseSha.slice(0, 7);
}

/**
 * Delete the integration branch (disable cleanup). The branch is derived
 * state — lane lists persist separately, so re-enabling loses nothing.
 * Force-delete: the chain's merge commits are reachable from nothing else
 * by design. Best-effort; the branch may not exist.
 */
export async function deleteIntegrationBranch(cwd: string): Promise<boolean> {
  return gitOk(cwd, ['branch', '-D', integrationBranch()]);
}

/**
 * After the base changes, the templated branch name may change too
 * (integration/main → integration/staging). Rename the checkout's current
 * branch to match; `git branch -m` carries branch.* config (pushRemote)
 * along. Returns the rename performed, if any.
 */
export async function alignIntegrationBranchName(
  checkoutPath: string,
): Promise<{ from: string; to: string } | undefined> {
  const target = integrationBranch();
  const current = await currentBranch(checkoutPath);
  if (!current || current === target) {
    return undefined;
  }
  await git(checkoutPath, ['branch', '-m', current, target]);
  return { from: current, to: target };
}

export async function abortIntegrationMerge(
  workingPath: string,
): Promise<void> {
  await git(workingPath, ['merge', '--abort']);
}

/**
 * Change signal for auto-rebuild: base + applied lane tips. When this
 * moves, the integration tree is stale. The integration checkout's own
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
