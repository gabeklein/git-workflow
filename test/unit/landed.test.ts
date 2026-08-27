import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findLandedLanes,
  findStaleLandedLanes,
  laneNeverDiverged,
} from '../../src/git/integration/status';
import { addBranch, git, makeRepo, type ScratchRepo } from './helpers';

/**
 * The landed predicate (ancestry ∪ content-neutral, revert-safe) — the
 * same cases the EDH 'landed lifecycle' scenario exercises end-to-end,
 * here directly against a scratch repo.
 */
describe('findLandedLanes', () => {
  let scratch: ScratchRepo;
  beforeEach(() => {
    scratch = makeRepo({ withOrigin: true });
    addBranch(scratch.repo, 'feat/x', 'x.txt', 'from x\n');
    git(scratch.repo, ['push', '-q', 'origin', 'feat/x']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  const land = (args: string[]) => {
    git(scratch.landing, ['fetch', '-q', 'origin']);
    git(scratch.landing, args);
    git(scratch.landing, ['push', '-q']);
    git(scratch.repo, ['fetch', '-q', 'origin']);
  };

  it('unmerged lane is not landed', async () => {
    expect(
      await findLandedLanes(scratch.repo, 'origin/main', ['feat/x']),
    ).toEqual([]);
  });

  it('true-merge landing → landed (ancestry)', async () => {
    land(['merge', '-q', '--no-ff', '-m', 'Merge PR feat/x', 'origin/feat/x']);
    expect(
      await findLandedLanes(scratch.repo, 'origin/main', ['feat/x']),
    ).toEqual(['feat/x']);
  });

  it('squash landing → landed (content-neutral)', async () => {
    git(scratch.landing, ['fetch', '-q', 'origin']);
    git(scratch.landing, ['merge', '-q', '--squash', 'origin/feat/x']);
    git(scratch.landing, ['commit', '-qm', 'feat x (squash)']);
    git(scratch.landing, ['push', '-q']);
    git(scratch.repo, ['fetch', '-q', 'origin']);
    expect(
      await findLandedLanes(scratch.repo, 'origin/main', ['feat/x']),
    ).toEqual(['feat/x']);
  });

  it('reverted squash → NOT landed (revert-safety)', async () => {
    git(scratch.landing, ['fetch', '-q', 'origin']);
    git(scratch.landing, ['merge', '-q', '--squash', 'origin/feat/x']);
    git(scratch.landing, ['commit', '-qm', 'feat x (squash)']);
    const squashSha = git(scratch.landing, ['rev-parse', 'HEAD']);
    git(scratch.landing, ['revert', '--no-edit', squashSha]);
    git(scratch.landing, ['push', '-q']);
    git(scratch.repo, ['fetch', '-q', 'origin']);
    expect(
      await findLandedLanes(scratch.repo, 'origin/main', ['feat/x']),
    ).toEqual([]);
  });

  it('missing branch is simply not landed (no throw)', async () => {
    expect(
      await findLandedLanes(scratch.repo, 'origin/main', ['feat/nope']),
    ).toEqual([]);
  });

  it('conflicting lane is not landed', async () => {
    fs.writeFileSync(path.join(scratch.landing, 'x.txt'), 'base disagrees\n');
    git(scratch.landing, ['add', 'x.txt']);
    git(scratch.landing, ['commit', '-qm', 'base rewrites x.txt']);
    git(scratch.landing, ['push', '-q']);
    git(scratch.repo, ['fetch', '-q', 'origin']);
    expect(
      await findLandedLanes(scratch.repo, 'origin/main', ['feat/x']),
    ).toEqual([]);
  });

  // An empty lane is an ancestor of the base like a landed one, but it has
  // nothing to retire — it is a worktree waiting for its first commit.
  it('a fresh branch at the base tip is EMPTY, not landed', async () => {
    git(scratch.repo, ['branch', 'feat/fresh', 'origin/main']);
    expect(
      await findStaleLandedLanes(scratch.repo, 'origin/main', ['feat/fresh']),
    ).toEqual([]);
  });

  it('a fresh branch the base has moved past is still empty', async () => {
    git(scratch.repo, ['branch', 'feat/fresh', 'origin/main']);
    land(['commit', '-q', '--allow-empty', '-m', 'base moves on']);
    expect(
      await findStaleLandedLanes(scratch.repo, 'origin/main', ['feat/fresh']),
    ).toEqual([]);
  });

  it('the first commit makes an empty lane real again', async () => {
    git(scratch.repo, ['branch', 'feat/fresh', 'origin/main']);
    git(scratch.repo, ['checkout', '-q', 'feat/fresh']);
    fs.writeFileSync(path.join(scratch.repo, 'fresh.txt'), 'work\n');
    git(scratch.repo, ['add', '-A']);
    git(scratch.repo, ['commit', '-qm', 'first commit']);
    git(scratch.repo, ['checkout', '-q', 'main']);
    git(scratch.repo, ['push', '-q', 'origin', 'feat/fresh']);
    expect(
      await findStaleLandedLanes(scratch.repo, 'origin/main', ['feat/fresh']),
    ).toEqual([]);
    // ...and landing it now reads as landed, not empty
    land([
      'merge',
      '-q',
      '--no-ff',
      '-m',
      'Merge feat/fresh',
      'origin/feat/fresh',
    ]);
    expect(
      await findStaleLandedLanes(scratch.repo, 'origin/main', ['feat/fresh']),
    ).toEqual(['feat/fresh']);
  });
});

describe('laneNeverDiverged', () => {
  let scratch: ScratchRepo;
  beforeEach(() => {
    scratch = makeRepo();
  });
  afterEach(() => {
    scratch.cleanup();
  });

  const sha = (ref: string) => git(scratch.repo, ['rev-parse', ref]);

  it('separates a fresh branch from a true-merge landing', async () => {
    git(scratch.repo, ['branch', 'fresh', 'main']);
    addBranch(scratch.repo, 'done', 'd.txt', 'done\n');
    git(scratch.repo, ['merge', '-q', '--no-ff', '-m', 'Merge done', 'done']);
    // main moves further, so neither tip equals the base tip
    git(scratch.repo, ['commit', '-q', '--allow-empty', '-m', 'more main']);

    const base = sha('main');
    expect(await laneNeverDiverged(scratch.repo, sha('fresh'), base)).toBe(true);
    expect(await laneNeverDiverged(scratch.repo, sha('done'), base)).toBe(
      false,
    );
  });

  it('a lane that is no ancestor at all never reads as empty', async () => {
    addBranch(scratch.repo, 'side', 's.txt', 'side\n');
    expect(await laneNeverDiverged(scratch.repo, sha('side'), sha('main'))).toBe(
      false,
    );
  });
});

/**
 * The landings the rebuild's cheap check cannot see. A lane that landed
 * and then watched other PRs merge on top conflicts against the base, so
 * the fast predicate reads it as unlanded: it never retires and sits in
 * the preview reporting a conflict forever.
 *
 * This probe walks base history to find it, which is why it is a separate
 * function on a slow cadence rather than part of findLandedLanes — putting
 * it in the rebuild made CI loads take eighteen seconds.
 */
describe('findStaleLandedLanes', () => {
  let scratch: ScratchRepo;

  const write = (f: string, body: string) => {
    fs.writeFileSync(path.join(scratch.repo, f), body);
    git(scratch.repo, ['add', '-A']);
  };

  beforeEach(() => {
    scratch = makeRepo({ withOrigin: true });
    write('app.txt', 'one\ntwo\nthree\n');
    git(scratch.repo, ['commit', '-qm', 'app']);
    git(scratch.repo, ['push', '-q', 'origin', 'main']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('retires a lane the base has since moved past', async () => {
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/old', 'main']);
    write('app.txt', 'one\nLANE\nthree\n');
    git(scratch.repo, ['commit', '-qm', 'lane work']);
    git(scratch.repo, ['checkout', '-q', 'main']);
    git(scratch.repo, ['merge', '-q', '--squash', 'feat/old']);
    git(scratch.repo, ['commit', '-qm', 'lane work (#1)']);
    // ...then other PRs land on the same lines
    write('app.txt', 'one\nLANE\nthree\nlater\n');
    git(scratch.repo, ['commit', '-qm', 'later (#2)']);
    write('app.txt', 'one\nLANE AGAIN\nthree\nlater\n');
    git(scratch.repo, ['commit', '-qm', 'later still (#3)']);
    git(scratch.repo, ['push', '-q', 'origin', 'main']);

    expect(
      await findStaleLandedLanes(scratch.repo, 'origin/main', ['feat/old']),
    ).toEqual(['feat/old']);
  });

  it('still keeps a lane whose work never landed', async () => {
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/live', 'main']);
    write('app.txt', 'one\nLIVE\nthree\n');
    git(scratch.repo, ['commit', '-qm', 'live work']);
    git(scratch.repo, ['checkout', '-q', 'main']);

    expect(
      await findStaleLandedLanes(scratch.repo, 'origin/main', ['feat/live']),
    ).toEqual([]);
  });

  it('does not retire an EMPTY lane — it has nothing to retire', async () => {
    git(scratch.repo, ['branch', 'feat/fresh', 'main']);
    expect(
      await findStaleLandedLanes(scratch.repo, 'origin/main', ['feat/fresh']),
    ).toEqual([]);
  });
});
