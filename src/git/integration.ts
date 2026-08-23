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
  | { ok: true; lanes: string[]; skipped: string[]; landed: string[] }
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
  const sha = async (ref: string) => {
    try {
      return (
        await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])
      ).trim();
    } catch {
      return undefined;
    }
  };
  // When both exist, prefer the DESCENDANT: the remote tip when PRs land
  // on the host, the local tip in local-only workflows where the user
  // advances the base directly. Diverged → origin (a fetch reconciles).
  const remote = await sha(`origin/${name}`);
  const local = await sha(`refs/heads/${name}`);
  if (remote && local && remote !== local) {
    if (await gitOk(cwd, ['merge-base', '--is-ancestor', remote, local])) {
      return local;
    }
    return remote;
  }
  return remote ?? local ?? sha(baseRef);
}

/** Best-effort `git fetch origin <base>` so origin/<base> tracks reality. */
export async function fetchIntegrationBase(
  cwd: string,
  baseRef: string,
): Promise<boolean> {
  const name = baseRef.replace(/^origin\//, '');
  return gitOk(cwd, ['fetch', 'origin', name]);
}

/**
 * Lanes that LANDED: merging them into the base changes nothing. One
 * predicate for badges and retirement, deliberately content-based:
 * - ancestry (true-merge landings) — merging an ancestor is a no-op;
 * - content-neutral (squash/rebase landings) — a STRICT off-tree merge
 *   yields the base tree unchanged.
 * Revert-safe by construction: after a squash-merge is reverted, merging
 * the lane again WOULD change the tree, so it is not landed.
 */
export async function findLandedLanes(
  cwd: string,
  baseRef: string,
  lanes: string[],
): Promise<string[]> {
  const baseSha = await resolveBaseSha(cwd, baseRef);
  if (!baseSha) {
    return [];
  }
  let baseTree: string;
  try {
    baseTree = (await git(cwd, ['rev-parse', `${baseSha}^{tree}`])).trim();
  } catch {
    return [];
  }
  const landed: string[] = [];
  for (const lane of lanes) {
    let laneSha: string;
    try {
      laneSha = (
        await git(cwd, ['rev-parse', '--verify', `refs/heads/${lane}^{commit}`])
      ).trim();
    } catch {
      continue; // branch gone — not our call to make
    }
    if (await gitOk(cwd, ['merge-base', '--is-ancestor', laneSha, baseSha])) {
      landed.push(lane);
      continue;
    }
    try {
      const result = await mergeOffTree(cwd, baseSha, laneSha, {
        strict: true,
      });
      if (result.kind === 'tree' && result.tree === baseTree) {
        landed.push(lane);
      }
    } catch {
      // probe failure ⇒ not landed
    }
  }
  return landed;
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
  opts?: { strict?: boolean },
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
      // strict: decisions (like landed detection) must not vary with the
      // user's auto-resolve preference
      ...(opts?.strict ? [] : autoResolveArgs()),
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

    // One landed predicate (ancestry ∪ content-neutral, strict)
    const landedSet = new Set(
      await findLandedLanes(workingPath, baseRef, lanes).catch(() => []),
    );

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
    const landed: string[] = [];
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
      let isSnapshot = false;
      if (wipLanes.has(lane)) {
        const checkout = laneCheckouts.get(lane);
        if (checkout) {
          try {
            const snapshot = await snapshotWorktreeCommit(checkout, lane);
            if (snapshot) {
              laneSha = snapshot;
              isSnapshot = true;
            }
          } catch {
            // snapshot failed — merge the branch tip instead
          }
        }
      }
      // Landed: merging the branch tip adds nothing (strict, precomputed).
      // A wip snapshot is never landed — its uncommitted edits remain.
      if (!isSnapshot && landedSet.has(lane)) {
        landed.push(lane);
        continue;
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
        return rebuildInWorktree(workingPath, baseSha, lanes, landedSet);
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

    // Retire landed lanes while still holding the lock — the applied file
    // is shared with the shell script, so it only changes under the lock
    if (landed.length > 0) {
      await writeLaneFile(
        workingPath,
        APPLIED_FILE,
        lanes.filter((l) => !landed.includes(l)),
      );
    }

    // Single working-tree update; git rewrites only files whose content changed
    await git(workingPath, ['reset', '--hard', current]);
    return { ok: true, lanes: merged, skipped, landed };
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
  landedSet: Set<string>,
): Promise<RebuildResult> {
  await git(workingPath, ['reset', '--hard', baseSha]);
  const skipped: string[] = [];
  const merged: string[] = [];
  const landed: string[] = [];
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
    if (landedSet.has(lane)) {
      landed.push(lane);
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
  // Caller holds the rebuild lock — safe to retire landed lanes here too
  if (landed.length > 0) {
    await writeLaneFile(
      workingPath,
      APPLIED_FILE,
      lanes.filter((l) => !landed.includes(l)),
    );
  }
  return { ok: true, lanes: merged, skipped, landed };
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

export interface BaseStatus {
  /** Commits the base has that this branch lacks */
  behind: number;
  /** Commits this branch has that the base lacks */
  ahead: number;
  /** Merging/rebasing onto the base would conflict (strict off-tree probe) */
  conflicts: boolean;
  refSha: string;
  baseSha: string;
}

/**
 * How a branch relates to the base — no working-tree access. The conflict
 * probe is STRICT (independent of integrationAutoResolve): the badge must
 * reflect what a real `git rebase`/`git merge` would hit.
 */
export async function baseStatusFor(
  cwd: string,
  ref: string,
  baseRef: string,
  /** Probe results keyed `${refSha}:${baseSha}` — pass a persistent map
   *  so merge-tree probes rerun only when a tip actually moves. */
  probeMemo?: Map<string, boolean>,
): Promise<BaseStatus | undefined> {
  const baseSha = await resolveBaseSha(cwd, baseRef);
  if (!baseSha) {
    return undefined;
  }
  let refSha: string;
  try {
    refSha = (
      await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])
    ).trim();
  } catch {
    return undefined;
  }
  const counts = (
    await git(cwd, [
      'rev-list',
      '--left-right',
      '--count',
      `${refSha}...${baseSha}`,
    ])
  )
    .trim()
    .split(/\s+/);
  const ahead = Number(counts[0]) || 0;
  const behind = Number(counts[1]) || 0;
  let conflicts = false;
  if (behind > 0 && ahead > 0) {
    const memoKey = `${refSha}:${baseSha}`;
    const memoized = probeMemo?.get(memoKey);
    if (memoized !== undefined) {
      conflicts = memoized;
    } else {
      const probe = await mergeOffTree(cwd, refSha, baseSha, {
        strict: true,
      }).catch(() => ({ kind: 'tree' }) as const);
      conflicts = probe.kind === 'conflict';
      probeMemo?.set(memoKey, conflicts);
      if (probeMemo && probeMemo.size > 512) {
        probeMemo.clear();
      }
    }
  }
  return { behind, ahead, conflicts, refSha, baseSha };
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
