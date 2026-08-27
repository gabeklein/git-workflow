import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addAppliedLane,
  listAppliedLanes,
  reorderAppliedLane,
} from '../../src/git/integration/lanes';
import { makeRepo, type ScratchRepo } from './helpers';

/**
 * Moving a lane in the merge order. Order decides conflict outcomes —
 * union inserts land in merge order, best-effort resolves toward the
 * incoming lane — so this is how a drag says which lane wins.
 */
describe('reorderAppliedLane', () => {
  let scratch: ScratchRepo;
  const applied = () => listAppliedLanes(scratch.repo);

  beforeEach(async () => {
    scratch = makeRepo();
    for (const lane of ['a', 'b', 'c']) {
      await addAppliedLane(scratch.repo, lane);
    }
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('moves a lane before another', async () => {
    expect(await reorderAppliedLane(scratch.repo, 'c', 'b')).toBe(true);
    expect(await applied()).toEqual(['a', 'c', 'b']);
  });

  it('moves a lane last when there is no target', async () => {
    expect(await reorderAppliedLane(scratch.repo, 'a')).toBe(true);
    expect(await applied()).toEqual(['b', 'c', 'a']);
  });

  it('moving backwards works too', async () => {
    expect(await reorderAppliedLane(scratch.repo, 'c', 'a')).toBe(true);
    expect(await applied()).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when nothing would move', async () => {
    expect(await reorderAppliedLane(scratch.repo, 'b', 'c')).toBe(false);
    expect(await applied()).toEqual(['a', 'b', 'c']);
  });

  it('ignores a lane that is not applied', async () => {
    expect(await reorderAppliedLane(scratch.repo, 'ghost', 'a')).toBe(false);
    expect(await applied()).toEqual(['a', 'b', 'c']);
  });

  it('treats a vanished target as "last" rather than failing', async () => {
    // The target retired while the drag was in flight
    expect(await reorderAppliedLane(scratch.repo, 'a', 'retired')).toBe(true);
    expect(await applied()).toEqual(['b', 'c', 'a']);
  });

  it('refuses while a rebuild holds the lock, and changes nothing', async () => {
    const lock = path.join(scratch.repo, '.git', 'focus-working.lock');
    fs.mkdirSync(lock);
    try {
      expect(await reorderAppliedLane(scratch.repo, 'c', 'a')).toBe(false);
      expect(await applied()).toEqual(['a', 'b', 'c']);
    } finally {
      fs.rmdirSync(lock);
    }
    // ...and works again once the rebuild is done
    expect(await reorderAppliedLane(scratch.repo, 'c', 'a')).toBe(true);
  });

  it('releases the lock it took', async () => {
    await reorderAppliedLane(scratch.repo, 'c', 'a');
    expect(
      fs.existsSync(path.join(scratch.repo, '.git', 'focus-working.lock')),
    ).toBe(false);
  });
});
