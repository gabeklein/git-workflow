import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLandedLanes } from '../../src/git/integration/status';
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
});
