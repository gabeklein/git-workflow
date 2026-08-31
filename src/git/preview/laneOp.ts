import { gitOk } from '../exec';
import {
  addAppliedLane,
  addCandidateLane,
  addExcludedLane,
  dropAppliedLane,
  dropCandidateLane,
  dropExcludedLane,
  listAppliedLanes,
  listCandidateLanes,
  withRepoLock,
} from './lanes';

/**
 * Changing who is in the preview — one implementation, four verbs.
 *
 * These used to be spelled out twice: once in the controller (as three
 * methods composing the lane-file helpers) and once in `gw-lane` as shell
 * that edited the same files by hand. They agreed by inspection only, and
 * the two that looked alike were not: the sidebar's uncheck leaves a lane
 * a candidate, while Remove excludes it so auto-membership cannot put the
 * row straight back. A shell script "doing the same thing" as a checkbox
 * is exactly where that distinction goes missing.
 *
 *   apply      in the preview, and offered — the opt-in
 *   unapply    out of the tree, still offered (the checkbox)
 *   remove     out, and kept out (auto-membership must not re-add it)
 *   candidate  offered but not applied (Add to Preview, unchecked)
 *
 * Taken under the rebuild lock, because a read-modify-write outside it can
 * undo a lane the rebuild just retired.
 */

export type LaneOpName = 'apply' | 'unapply' | 'remove' | 'candidate';

export const LANE_OPS: readonly LaneOpName[] = [
  'apply',
  'unapply',
  'remove',
  'candidate',
];

export function isLaneOp(name: string): name is LaneOpName {
  return (LANE_OPS as readonly string[]).includes(name);
}

export type LaneOpResult =
  | { ok: true; op: LaneOpName; lane: string; changed: boolean }
  | { ok: false; code: 'busy' | 'no-such-branch'; message: string };

export async function runLaneOp(
  cwd: string,
  op: LaneOpName,
  lane: string,
): Promise<LaneOpResult> {
  // Only joining requires the branch to exist. Leaving must work for a
  // branch that is already gone — that is precisely when a stale row needs
  // clearing, and refusing would strand it.
  if (
    (op === 'apply' || op === 'candidate') &&
    !(await gitOk(cwd, ['rev-parse', '-q', '--verify', `refs/heads/${lane}`]))
  ) {
    return { ok: false, code: 'no-such-branch', message: `no such branch: ${lane}` };
  }

  const done = await withRepoLock(cwd, `lane ${op} ${lane}`, async () => {
    const before = [
      ...(await listAppliedLanes(cwd)),
      ...(await listCandidateLanes(cwd)),
    ].join('\n');
    switch (op) {
      case 'apply':
        // Re-applying is also how an excluded row opts back in
        await dropExcludedLane(cwd, lane);
        await addCandidateLane(cwd, lane);
        await addAppliedLane(cwd, lane);
        break;
      case 'unapply':
        await dropAppliedLane(cwd, lane);
        break;
      case 'remove':
        await dropAppliedLane(cwd, lane);
        await dropCandidateLane(cwd, lane);
        // Persist the choice: auto-membership would put the row back
        await addExcludedLane(cwd, lane);
        break;
      case 'candidate':
        await dropExcludedLane(cwd, lane);
        await addCandidateLane(cwd, lane);
        break;
    }
    const after = [
      ...(await listAppliedLanes(cwd)),
      ...(await listCandidateLanes(cwd)),
    ].join('\n');
    return before !== after;
  });

  if (done === undefined) {
    return {
      ok: false,
      code: 'busy',
      message: 'the preview is busy (rebuild lock held) — try again in a moment',
    };
  }
  return { ok: true, op, lane, changed: done };
}
