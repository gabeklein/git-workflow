import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { git, GitError, gitOk } from '../exec';
import { listWorktreeAdmin } from '../worktreeAdmin';
import { autoResolveArgs, integrationBranch } from './config';
import {
  APPLIED_FILE,
  LOCK_DIR,
  commonDir,
  listAppliedLanes,
  listWipLanes,
  writeLaneFile,
} from './lanes';
import { mergeOffTree } from './merge';
import { findLandedLanes, resolveBaseSha } from './status';


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

const WIP_SUBJECT = 'wip(gw):';
let wipIndexCounter = 0;

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
