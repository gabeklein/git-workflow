import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { git, gitOk } from '../exec';
import { gitErrorMessage, isWorktreeDirty, revParseCommit } from '../plumbing';
import { listWorktreeAdmin } from '../worktreeAdmin';
import type { Preview } from './identity';
import {
  autoResolveArgs,
  conflictResolverMode,
  currentPreview,
  WIP_SUBJECT,
} from './config';
import {
  APPLIED_FILE,
  LOCK_DIR,
  commonDir,
  listAppliedLanes,
  listCandidateLanes,
  listExcludedLanes,
  listWipLanes,
  writeLaneFile,
} from './lanes';
import { mergeOffTree, resolveConflictedTree } from './merge';
import { findLandedLanes, findStrayCommits, resolveBaseSha } from './status';


/**
 * Preview-worktree overlay (interop with agent-focus's
 * scripts/focus-working.sh): a checkout on the preview branch is never
 * worked in directly — it is rebuilt as <base> plus a merge of each
 * "applied" lane (feature branch). Lanes merge landed commits only; dirty
 * feature worktrees never affect the preview tree.
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

/** A lane whose conflicts the resolver settled instead of failing. */
export interface ResolvedLane {
  lane: string;
  /** Files resolved losslessly (union insert / linewise 3-way). */
  lossless: string[];
  /** Files resolved toward the lane — a clashing hunk was dropped. */
  lossy: string[];
}

export type RebuildResult =
  | {
      ok: true;
      lanes: string[];
      skipped: string[];
      landed: string[];
      /** Lanes that needed the conflict resolver (empty = clean merges). */
      resolved: ResolvedLane[];
    }
  | {
      ok: false;
      code: 'busy' | 'dirty' | 'unique' | 'conflict' | 'moved' | 'error';
      message: string;
      lane?: string;
    };

/**
 * The branch a checkout currently has, or '' when detached.
 *
 * A rebuild ends by resetting `workingPath` HARD, which is only ever safe
 * while that checkout still holds the preview branch. Enabling
 * preview by switching the ROOT checkout in place makes this a live
 * hazard: pop out to the base to commit something, and a rebuild triggered
 * by that very commit would reset the BASE branch onto the preview
 * chain. The controller's cached previewPath outlives the switch by
 * however long it takes the next refresh to notice.
 */
async function checkedOutBranch(workingPath: string): Promise<string> {
  return (
    await git(workingPath, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(
      () => '',
    )
  ).trim();
}

/**
 * The committed chain — base plus every applied lane's tip, merged in
 * order — memoized per checkout.
 *
 * A wip overlay rebuilds on every SAVE in the lane's worktree, and that
 * used to redo the entire chain each time. Splitting wip out into a final
 * overlay (#35) left the committed part byte-identical between those
 * rebuilds, which is what makes caching it correct rather than merely
 * tempting.
 *
 * In memory only: the first rebuild after a reload recomputes, which costs
 * one rebuild and saves having to invalidate anything on disk.
 */
interface ChainCache {
  key: string;
  tip: string;
  merged: string[];
  landed: string[];
  resolved: ResolvedLane[];
}

const chainCache = new Map<string, ChainCache>();

/**
 * Every input that can change the committed chain's tree: the base, the
 * resolver mode (it decides how conflicts resolve), and each lane's tip in
 * ORDER — order is not incidental, it decides which lane wins.
 */
function chainKey(
  baseSha: string,
  mode: string,
  tips: [string, string | undefined][],
): string {
  return [
    baseSha,
    mode,
    ...tips.map(([lane, sha]) => `${lane}@${sha ?? 'gone'}`),
  ].join('\n');
}

/** Drop the memo for a checkout — its objects may no longer be reachable. */
export function forgetChainCache(workingPath?: string): void {
  if (workingPath) {
    chainCache.delete(workingPath);
  } else {
    chainCache.clear();
  }
}

export async function rebuildPreview(
  workingPath: string,
  baseRef: string,
  /** Which preview this is. Defaults to the configured one; pass it
   *  explicitly and the engine never consults the workspace setting. */
  preview: Preview = currentPreview(),
): Promise<RebuildResult> {
  const previewBranch = preview.branch;
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
    if (await gitOk(workingPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']))
      await git(workingPath, ['merge', '--abort']);

    if (await isWorktreeDirty(workingPath)) {
      return {
        ok: false,
        code: 'dirty',
        message: 'preview checkout is dirty; not rebuilding',
      };
    }

    // Merge order = the candidate list, filtered to applied. Order and
    // membership live in separate files so that checking a lane cannot
    // restate where it merges — see reorderLane.
    const applied = new Set(await listAppliedLanes(workingPath));
    const order = await listCandidateLanes(workingPath);
    const lanes = [
      ...order.filter((l) => applied.has(l)),
      // Anything applied without a candidate entry — the shell script
      // appends straight to focus-applied — keeps appending's meaning.
      ...[...applied].filter((l) => !order.includes(l)).sort(),
    ];
    const baseSha = await resolveBaseSha(workingPath, baseRef);
    if (!baseSha) {
      return {
        ok: false,
        code: 'error',
        message: `base ref ${baseRef} does not resolve`,
      };
    }

    // Unique-commit guard: refuse when work was committed DIRECTLY on the
    // preview checkout. The tree is derived and about to be reset, so
    // those commits would simply vanish. Absorbing them into a real branch
    // is the exit (see absorb.ts) — this only refuses to destroy them.
    const strays = await findStrayCommits(workingPath, baseSha, previewBranch);
    if (strays.length > 0) {
      return {
        ok: false,
        code: 'unique',
        message:
          'preview checkout has commits that exist on no other branch; move them to a feature branch first',
      };
    }

    // One landed predicate (ancestry ∪ content-neutral, strict)
    const landedSet = new Set(
      await findLandedLanes(workingPath, baseRef, lanes).catch(() => []),
    );

    // Base drift as a lane: unpushed commits on the local base branch are
    // NOT base movement (the pin holds) — they are unlanded work, so by
    // default they join the preview like any lane, merged FIRST. Uncheck
    // (the base name in focus-excluded) opts out; pushing lands them and
    // the segment stops existing. The chain list is separate from `lanes`
    // so retirement/wip bookkeeping never sees the synthetic entry.
    const baseName = baseRef.replace(/^origin\//, '');
    const chainLanes = lanes.slice();
    {
      const localBase = await revParseCommit(
        workingPath,
        `refs/heads/${baseName}`,
      );
      const excluded = await listExcludedLanes(workingPath).catch((): string[] => []);
      if (
        localBase &&
        localBase !== baseSha &&
        !excluded.includes(baseName) &&
        !(await gitOk(workingPath, [
          'merge-base',
          '--is-ancestor',
          localBase,
          baseSha,
        ]))
      ) {
        chainLanes.unshift(baseName);
      }
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
          if (state.branch) laneCheckouts.set(state.branch, state.path);
        }
      } catch {
        // no lookup — wip lanes fall back to branch tips
      }
    }

    // Compute the whole chain off-tree, then apply once
    let current = baseSha;
    const skipped: string[] = [];
    let merged: string[] = [];
    let landed: string[] = [];
    let resolved: ResolvedLane[] = [];

    const tips: [string, string | undefined][] = [];
    for (const lane of chainLanes) {
      tips.push([lane, await revParseCommit(workingPath, `refs/heads/${lane}`)]);
    }
    const key = chainKey(baseSha, conflictResolverMode(), tips);
    const cached = chainCache.get(workingPath);
    // Verify the tip still exists: disabling preview deletes the
    // branch, after which gc can prune a commit nothing references.
    const reusable =
      cached?.key === key &&
      (await gitOk(workingPath, [
        'rev-parse',
        '-q',
        '--verify',
        `${cached.tip}^{commit}`,
      ]));
    if (cached && reusable) {
      current = cached.tip;
      merged = cached.merged.slice();
      landed = cached.landed.slice();
      resolved = cached.resolved.slice();
    } else {
      for (const lane of chainLanes) {
        const laneSha = await revParseCommit(workingPath, `refs/heads/${lane}`);
        if (!laneSha) {
          skipped.push(lane);
          continue;
        }
        // Landed: merging the branch tip adds nothing (strict, precomputed).
        // Its wip, if any, is still overlaid below — uncommitted edits have
        // not landed anywhere, so a lane holding them is NOT retired. Doing
        // so would unapply it, and the next rebuild would drop the overlay
        // with the row.
        if (landedSet.has(lane)) {
          if (!wipLanes.has(lane)) landed.push(lane);
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
          return rebuildInWorktree(
          workingPath,
          baseSha,
          lanes,
          landedSet,
          previewBranch,
        );
        }
        let mergedTree: string;
        if (result.kind === 'conflict') {
          // Petty-conflict resolver: lossless rules first (union of
          // insert-only sides, linewise 3-way), then — in best-effort mode —
          // lane-wins per file, reported so the UI can tag the row.
          const mode = conflictResolverMode();
          const resolution =
            mode === 'none'
              ? { unresolved: result.files }
              : await resolveConflictedTree(
                  workingPath,
                  current,
                  laneSha,
                  result.tree,
                  result.files,
                  mode,
                ).catch(() => ({ unresolved: result.files }));
          if ('unresolved' in resolution) {
            const files = resolution.unresolved.slice(0, 5).join(', ');
            return {
              ok: false,
              code: 'conflict',
              lane,
              message: `lane ${lane} conflicts${files ? `: ${files}` : ''}${
                resolution.unresolved.length > 5 ? ', …' : ''
              } (checkout untouched)`,
            };
          }
          mergedTree = resolution.tree;
          resolved.push({
            lane,
            lossless: resolution.lossless,
            lossy: resolution.lossy,
          });
        } else {
          mergedTree = result.tree;
        }
        current = (
          await git(workingPath, [
            'commit-tree',
            mergedTree,
            '-p',
            current,
            '-p',
            laneSha,
            '-m',
            `${previewBranch}: ${lane}`,
          ])
        ).trim();
        merged.push(lane);
      }
      chainCache.set(workingPath, {
        key,
        tip: current,
        merged: merged.slice(),
        landed: landed.slice(),
        resolved: resolved.slice(),
      });
    }

    // Wip overlay, LAST and on top of the finished chain.
    //
    // Not by reordering the dirty lane to the end: that would move its
    // COMMITTED work too, and since the resolver is order-sensitive it
    // would change how those hunks resolve against every other lane. Which
    // worktree happens to be dirty would then decide preview content —
    // the same "order means something arbitrary" problem that sorting
    // focus-applied caused.
    //
    // So inclusion order governs committed work, and wip is an overlay.
    // mergeBase is the lane's own tip, which makes this cherry-pick
    // semantics: what lands is exactly the uncommitted delta, not the
    // lane's history a second time.
    for (const lane of chainLanes) {
      if (!wipLanes.has(lane)) continue;
      const checkout = laneCheckouts.get(lane);
      if (!checkout) {
        continue; // no worktree to read edits from
      }
      const laneSha = await revParseCommit(workingPath, `refs/heads/${lane}`);
      let snapshot: string | undefined;
      try {
        snapshot = (await snapshotWorktreeCommit(checkout, lane)) ?? undefined;
      } catch {
        snapshot = undefined; // nothing dirty, or the snapshot failed
      }
      if (!snapshot || !laneSha || snapshot === laneSha) continue;
      const result = await mergeOffTree(workingPath, current, snapshot, {
        mergeBase: laneSha,
      });
      if (result.kind === 'unsupported') {
        return rebuildInWorktree(
          workingPath,
          baseSha,
          lanes,
          landedSet,
          previewBranch,
        );
      }
      let overlayTree: string;
      if (result.kind === 'conflict') {
        // Routed through the SAME setting as everything else rather than
        // always winning: a silent win drops another lane's hunks from the
        // preview, and lossy resolutions are tagged here, not hidden.
        const mode = conflictResolverMode();
        const resolution =
          mode === 'none'
            ? { unresolved: result.files }
            : await resolveConflictedTree(
                workingPath,
                current,
                snapshot,
                result.tree,
                result.files,
                mode,
              ).catch(() => ({ unresolved: result.files }));
        if ('unresolved' in resolution) {
          const files = resolution.unresolved.slice(0, 5).join(', ');
          return {
            ok: false,
            code: 'conflict',
            lane,
            message: `working-tree edits in ${lane} conflict${
              files ? `: ${files}` : ''
            } (checkout untouched)`,
          };
        }
        overlayTree = resolution.tree;
        resolved.push({
          lane,
          lossless: resolution.lossless,
          lossy: resolution.lossy,
        });
      } else {
        overlayTree = result.tree;
      }
      current = (
        await git(workingPath, [
          'commit-tree',
          overlayTree,
          '-p',
          current,
          '-p',
          snapshot,
          '-m',
          `${previewBranch}: ${lane} (wip)`,
        ])
      ).trim();
      if (!merged.includes(lane)) merged.push(lane);
    }

    // Retire landed lanes while still holding the lock — the applied file
    // is shared with the shell script, so it only changes under the lock
    if (landed.length > 0) {
      await writeLaneFile(
        workingPath,
        APPLIED_FILE,
        lanes.filter((l) => !landed.includes(l)),
        { ordered: true },
      );
    }

    // Re-read the branch immediately before the reset, inside the lock:
    // everything above is off-tree and harmless, this line is not. Checking
    // here rather than on entry is deliberate — the checkout can be switched
    // away at any point while the chain is being computed.
    const branchNow = await checkedOutBranch(workingPath);
    if (branchNow !== previewBranch) {
      return {
        ok: false,
        code: 'moved',
        message: `${workingPath} is on ${
          branchNow || 'a detached HEAD'
        }, not ${previewBranch} — refusing to reset it`,
      };
    }

    // Single working-tree update; git rewrites only files whose content changed
    await git(workingPath, ['reset', '--hard', current]);
    return { ok: true, lanes: merged, skipped, landed, resolved };
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
  previewBranch: string,
): Promise<RebuildResult> {
  // Same hazard, and this path resets before doing anything else
  const branchNow = await checkedOutBranch(workingPath);
  if (branchNow !== previewBranch) {
    return {
      ok: false,
      code: 'moved',
      message: `${workingPath} is on ${
        branchNow || 'a detached HEAD'
      }, not ${previewBranch} — refusing to reset it`,
    };
  }
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
        `${previewBranch}: ${lane}`,
        lane,
      ]);
      merged.push(lane);
    } catch (err) {
      // Leave nothing half-merged on this fallback path either
      await git(workingPath, ['merge', '--abort']).catch(() => {});
      const message = gitErrorMessage(err);
      return { ok: false, code: 'conflict', message, lane };
    }
  }
  // Caller holds the rebuild lock — safe to retire landed lanes here too
  if (landed.length > 0) {
    await writeLaneFile(
      workingPath,
      APPLIED_FILE,
      lanes.filter((l) => !landed.includes(l)),
      { ordered: true },
    );
  }
  return { ok: true, lanes: merged, skipped, landed, resolved: [] };
}

/**
 * Enable the overlay in a separate worktree: create one on the preview
 * branch. Reuses the branch when it already exists; else branches off base.
 */

export async function abortPreviewMerge(
  workingPath: string,
): Promise<void> {
  await git(workingPath, ['merge', '--abort']);
}

/**
 * Change signal for auto-rebuild: base + applied lane tips. When this
 * moves, the preview tree is stale. The preview checkout's own
 * HEAD is deliberately excluded (the rebuild itself moves it).
 */
