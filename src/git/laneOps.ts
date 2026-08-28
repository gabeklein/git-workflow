import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { git, gitOk } from './exec';
import {
  landedPrefix,
  laneNeverDiverged,
  resolveBaseSha,
} from './preview/status';
import { gitErrorMessage, isWorktreeDirty, revParseCommit } from './plumbing';

/**
 * Manual catch-up operations on a lane's own worktree: rebase onto the
 * base or merge the base in, with pause/continue/abort around conflicts.
 * These run REAL git in the user's checkout (unlike the preview
 * engine's off-tree merges) — so every entry point refuses to start when
 * an operation is already in progress, and only ever aborts an operation
 * it started itself.
 */

export type LaneOpResult =
  | { status: 'done' }
  | { status: 'conflicts'; files: string[] }
  | { status: 'blocked' | 'error'; message: string };

/** A rebase is paused in this worktree (rebase-merge/rebase-apply). */
export async function rebaseInProgress(worktree: string): Promise<boolean> {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const p = (
      await git(worktree, ['rev-parse', '--git-path', dir]).catch(() => '')
    ).trim();
    if (p) {
      try {
        await fs.access(path.resolve(worktree, p));
        return true;
      } catch {
        // not present
      }
    }
  }
  return false;
}

/** A merge is paused in this worktree (MERGE_HEAD present). */
export async function baseMergeInProgress(
  worktree: string,
): Promise<boolean> {
  return gitOk(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
}

async function unmergedFiles(worktree: string): Promise<string[]> {
  return (
    await git(worktree, ['diff', '--name-only', '--diff-filter=U']).catch(
      () => '',
    )
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Refuse to start anything on top of a paused rebase/merge or dirty tree. */
async function startBlocker(worktree: string): Promise<string | undefined> {
  if (await rebaseInProgress(worktree))
    return 'a rebase is already in progress here — continue or abort it first';
  if (await baseMergeInProgress(worktree))
    return 'a merge is already in progress here — complete or abort it first';
  if (await isWorktreeDirty(worktree))
    return 'worktree has uncommitted changes — commit or stash first';
  return undefined;
}

/**
 * Move an EMPTY lane onto the base.
 *
 * A branch with no commits of its own reads as "behind" in the arithmetic
 * the badges use, while having nothing whatsoever to rebase — the fix is
 * to re-point it, not to replay anything. Lossless by construction: the
 * guard is that the lane never diverged from the base's own first-parent
 * line, so a fast-forward can drop nothing.
 *
 * Refuses on a dirty or mid-operation worktree like every other entry
 * point here: uncommitted work means the lane is not really empty.
 */
export async function fastForwardEmptyLane(
  worktree: string,
  baseRef: string,
): Promise<LaneOpResult> {
  const baseSha = await resolveBaseSha(worktree, baseRef);
  if (!baseSha)
    return { status: 'error', message: `base ref ${baseRef} does not resolve` };
  const head = (await git(worktree, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  if (!head)
    return { status: 'error', message: 'worktree HEAD does not resolve' };
  if (head === baseSha) {
    return { status: 'done' }; // already there
  }
  if (
    !(await gitOk(worktree, ['merge-base', '--is-ancestor', head, baseSha])) ||
    !(await laneNeverDiverged(worktree, head, baseSha))
  ) {
    return {
      status: 'blocked',
      message: 'lane has commits of its own — catch up instead',
    };
  }
  const blocker = await startBlocker(worktree);
  if (blocker) return { status: 'blocked', message: blocker };
  try {
    await git(worktree, ['merge', '--ff-only', baseSha]);
    return { status: 'done' };
  } catch (err) {
    return { status: 'error', message: gitErrorMessage(err) };
  }
}

/**
 * Rebase the lane onto the base. The target is resolveBaseSha — the same
 * descendant-aware resolution the row badges use, so the action always
 * fixes exactly what the badge reported. Clean rebases finish; conflicts
 * pause (visible as rebase state) for continueLaneRebase/abortLaneRebase.
 */
export async function startLaneRebase(
  worktree: string,
  baseRef: string,
): Promise<LaneOpResult> {
  const blocked = await startBlocker(worktree);
  if (blocked) return { status: 'blocked', message: blocked };
  const baseSha = await resolveBaseSha(worktree, baseRef);
  if (!baseSha)
    return { status: 'error', message: `base ${baseRef} does not resolve` };
  // Replay only what has NOT already landed. Plain `git rebase <base>`
  // replays everything in base..HEAD, which after a SQUASH merge of a
  // parent branch still lists the parent's originals — every one of them
  // conflicting against a base that already has the content.
  const head = await revParseCommit(worktree, 'HEAD');
  const forkPoint = head
    ? await landedPrefix(worktree, head, baseSha)
    : undefined;
  try {
    await git(
      worktree,
      forkPoint
        ? ['rebase', '--onto', baseSha, forkPoint]
        : ['rebase', baseSha],
    );
    return { status: 'done' };
  } catch (err) {
    const files = await unmergedFiles(worktree);
    if (files.length > 0) return { status: 'conflicts', files };
    // Broken mid-flight without conflicts — clean up the rebase WE started
    if (await rebaseInProgress(worktree))
      await git(worktree, ['rebase', '--abort']).catch(() => {});
    return { status: 'error', message: gitErrorMessage(err) };
  }
}

/**
 * Continue a paused rebase: stage resolutions, refuse while conflict
 * markers remain, `rebase --continue` (editor-less). The next commit may
 * conflict again — the result says so and the caller re-enters this flow.
 */
export async function continueLaneRebase(
  worktree: string,
): Promise<LaneOpResult> {
  if (!(await rebaseInProgress(worktree)))
    return { status: 'blocked', message: 'no rebase in progress' };
  const markers = await stagedConflictMarkers(worktree);
  if (markers) return { status: 'blocked', message: markers };
  const unmerged = await unmergedFiles(worktree);
  if (unmerged.length > 0) {
    return {
      status: 'blocked',
      message: `still unmerged: ${unmerged.join(', ')}`,
    };
  }
  try {
    await git(worktree, ['rebase', '--continue'], { GIT_EDITOR: 'true' });
    return { status: 'done' };
  } catch (err) {
    const files = await unmergedFiles(worktree);
    if (files.length > 0) return { status: 'conflicts', files };
    return { status: 'error', message: gitErrorMessage(err) };
  }
}

/** Abort the paused rebase (UI only offers this while one is paused). */
export async function abortLaneRebase(worktree: string): Promise<void> {
  if (!(await rebaseInProgress(worktree)))
    throw new Error('no rebase in progress');
  await git(worktree, ['rebase', '--abort']);
}

/**
 * Merge the base into the lane — the no-history-rewrite catch-up for
 * pushed branches. Clean merges commit immediately; conflicts pause
 * (MERGE_HEAD) for the editor's conflict UI + completeBaseMerge.
 */
export async function startBaseMerge(
  worktree: string,
  baseRef: string,
  branch: string,
): Promise<LaneOpResult> {
  const blocked = await startBlocker(worktree);
  if (blocked) return { status: 'blocked', message: blocked };
  const baseSha = await resolveBaseSha(worktree, baseRef);
  if (!baseSha)
    return { status: 'error', message: `base ${baseRef} does not resolve` };
  // A merge cannot skip history the way a rebase can, so when part of this
  // branch has already landed in the base the merge is guaranteed to
  // conflict on content that is not actually in dispute. Say so instead of
  // handing over a conflict nobody can resolve correctly — the exit is a
  // rebase, which rewrites history and is therefore the user's call.
  const head = await revParseCommit(worktree, 'HEAD');
  if (head && (await landedPrefix(worktree, head, baseSha))) {
    return {
      status: 'blocked',
      message: `part of ${branch} already landed in ${baseRef} (squashed or rebased), so merging would replay it as conflicts — catch up with a rebase instead`,
    };
  }
  const subject = `Merge ${baseRef.replace(/^origin\//, '')} into ${branch}`;
  try {
    await git(worktree, ['merge', '--no-edit', '-m', subject, baseSha]);
    return { status: 'done' };
  } catch (err) {
    const files = await unmergedFiles(worktree);
    if (files.length > 0) return { status: 'conflicts', files };
    if (await baseMergeInProgress(worktree))
      await git(worktree, ['merge', '--abort']).catch(() => {});
    return { status: 'error', message: gitErrorMessage(err) };
  }
}

/**
 * Finish a paused base merge: stage the resolutions, refuse while
 * conflict markers remain, commit with the prepared merge message.
 */
export async function completeBaseMerge(
  worktree: string,
): Promise<LaneOpResult> {
  if (!(await baseMergeInProgress(worktree)))
    return { status: 'blocked', message: 'no merge in progress' };
  const markers = await stagedConflictMarkers(worktree);
  if (markers) return { status: 'blocked', message: markers };
  const unmerged = await unmergedFiles(worktree);
  if (unmerged.length > 0) {
    return {
      status: 'blocked',
      message: `still unmerged: ${unmerged.join(', ')}`,
    };
  }
  try {
    await git(worktree, ['commit', '--no-edit'], { GIT_EDITOR: 'true' });
    return { status: 'done' };
  } catch (err) {
    return { status: 'error', message: gitErrorMessage(err) };
  }
}

/** Abort the paused base merge (UI only offers this while one is paused). */
export async function abortBaseMerge(worktree: string): Promise<void> {
  if (!(await baseMergeInProgress(worktree)))
    throw new Error('no merge in progress');
  await git(worktree, ['merge', '--abort']);
}

/**
 * Stage resolutions, then report leftover conflict markers (or undefined
 * when the index is clean of them). `git diff --cached --check` exits
 * non-zero for markers AND for whitespace complaints — only markers block.
 */
async function stagedConflictMarkers(
  worktree: string,
): Promise<string | undefined> {
  await git(worktree, ['add', '-u']);
  try {
    await git(worktree, ['diff', '--cached', '--check']);
    return undefined;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const detail = (e.stdout ?? '').trim() || (e.stderr ?? '').trim();
    if (detail.includes('conflict')) {
      return `conflict markers remain:\n${detail
        .split('\n')
        .slice(0, 4)
        .join('\n')}`;
    }
    return undefined; // whitespace complaints are not blockers
  }
}
