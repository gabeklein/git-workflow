import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addAppliedLane,
  addCandidateLane,
  dropAppliedLane,
  listAppliedLanes,
  listCandidateLanes,
  reorderLane,
} from '../../src/git/preview/lanes';
import { makeRepo, type ScratchRepo } from './helpers';

/**
 * Moving a lane in the merge order. Order decides conflict outcomes —
 * union inserts land in merge order, best-effort resolves toward the
 * incoming lane — so this is how a drag says which lane wins.
 *
 * Order lives in the CANDIDATE file, so an unchecked lane keeps its place
 * and reclaims it when checked; only dragging moves anything.
 */
describe('reorderLane', () => {
  let scratch: ScratchRepo;
  // The candidate file IS the order now; applied is a set on top of it.
  const order = () => listCandidateLanes(scratch.repo);

  beforeEach(async () => {
    scratch = makeRepo();
    for (const lane of ['a', 'b', 'c']) {
      await addCandidateLane(scratch.repo, lane);
      await addAppliedLane(scratch.repo, lane);
    }
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('moves a lane before another', async () => {
    expect(await reorderLane(scratch.repo, 'c', 'b')).toBe(true);
    expect(await order()).toEqual(['a', 'c', 'b']);
  });

  it('moves a lane last when there is no target', async () => {
    expect(await reorderLane(scratch.repo, 'a')).toBe(true);
    expect(await order()).toEqual(['b', 'c', 'a']);
  });

  it('moving backwards works too', async () => {
    expect(await reorderLane(scratch.repo, 'c', 'a')).toBe(true);
    expect(await order()).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when nothing would move', async () => {
    expect(await reorderLane(scratch.repo, 'b', 'c')).toBe(false);
    expect(await order()).toEqual(['a', 'b', 'c']);
  });

  it('ignores a lane it has never heard of', async () => {
    expect(await reorderLane(scratch.repo, 'ghost', 'a')).toBe(false);
    expect(await order()).toEqual(['a', 'b', 'c']);
  });

  it('treats a vanished target as "last" rather than failing', async () => {
    // The target retired while the drag was in flight
    expect(await reorderLane(scratch.repo, 'a', 'retired')).toBe(true);
    expect(await order()).toEqual(['b', 'c', 'a']);
  });

  it('refuses while a rebuild holds the lock, and changes nothing', async () => {
    const lock = path.join(scratch.repo, '.git', 'focus-working.lock');
    fs.mkdirSync(lock);
    try {
      expect(await reorderLane(scratch.repo, 'c', 'a')).toBe(false);
      expect(await order()).toEqual(['a', 'b', 'c']);
    } finally {
      fs.rmdirSync(lock);
    }
    // ...and works again once the rebuild is done
    expect(await reorderLane(scratch.repo, 'c', 'a')).toBe(true);
  });

  it('releases the lock it took', async () => {
    await reorderLane(scratch.repo, 'c', 'a');
    expect(
      fs.existsSync(path.join(scratch.repo, '.git', 'focus-working.lock')),
    ).toBe(false);
  });
});

/**
 * The bug this split exists for: checking a lane used to append it to the
 * applied file, so its row jumped to the end of the list under the cursor —
 * a toggle silently restating where a lane merges.
 */
describe('membership does not disturb order', () => {
  let scratch: ScratchRepo;
  const order = () => listCandidateLanes(scratch.repo);
  const applied = () => listAppliedLanes(scratch.repo);

  beforeEach(async () => {
    scratch = makeRepo();
    for (const lane of ['a', 'b', 'c']) {
      await addCandidateLane(scratch.repo, lane);
      await addAppliedLane(scratch.repo, lane);
    }
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('unchecking leaves the lane exactly where it was', async () => {
    await dropAppliedLane(scratch.repo, 'b');
    expect(await order()).toEqual(['a', 'b', 'c']);
    expect(await applied()).toEqual(['a', 'c']);
  });

  it('re-checking reclaims the same position, not the end', async () => {
    await dropAppliedLane(scratch.repo, 'a');
    await addAppliedLane(scratch.repo, 'a');
    expect(await order()).toEqual(['a', 'b', 'c']);
    // Merge order is the order filtered to applied, so 'a' merges FIRST
    // again — under the old model it would have merged last.
    const membership = new Set(await applied());
    expect((await order()).filter((l) => membership.has(l))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('a drag moves it, and membership still does not', async () => {
    expect(await reorderLane(scratch.repo, 'c', 'a')).toBe(true);
    expect(await order()).toEqual(['c', 'a', 'b']);
    await dropAppliedLane(scratch.repo, 'c');
    await addAppliedLane(scratch.repo, 'c');
    expect(await order()).toEqual(['c', 'a', 'b']);
  });
});
