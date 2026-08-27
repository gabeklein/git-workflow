import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findLandedBranches,
  pruneLandedBranches,
} from '../../src/git/pruneLanded';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Pruning local branches whose work is already in the base. The whole point
 * is the case `git branch -d` refuses — a squash merge, which is not an
 * ancestor of anything — so most of these assert on content, not ancestry.
 */
describe('prune landed branches', () => {
  let scratch: ScratchRepo;

  const commitOn = (branch: string, file: string, body: string) => {
    git(scratch.repo, ['checkout', '-q', '-b', branch, 'main']);
    fs.writeFileSync(path.join(scratch.repo, file), body);
    git(scratch.repo, ['add', '-A']);
    git(scratch.repo, ['commit', '-qm', `${branch} work`]);
    git(scratch.repo, ['checkout', '-q', 'main']);
  };

  const names = async (base = 'main') =>
    (await findLandedBranches(scratch.repo, base)).landed
      .map((b) => `${b.name}:${b.via}`)
      .sort();

  beforeEach(() => {
    scratch = makeRepo();
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('finds a SQUASH-merged branch, which git -d refuses to delete', async () => {
    commitOn('feat/squashed', 'a.txt', 'work\n');
    git(scratch.repo, ['merge', '-q', '--squash', 'feat/squashed']);
    git(scratch.repo, ['commit', '-qm', 'squashed work (#1)']);
    // The premise: git itself will not delete this
    expect(() => git(scratch.repo, ['branch', '-d', 'feat/squashed'])).toThrow();
    expect(await names()).toEqual(['feat/squashed:content']);
  });

  it('finds a true-merged branch by ancestry', async () => {
    commitOn('feat/merged', 'b.txt', 'work\n');
    git(scratch.repo, ['merge', '-q', '--no-ff', '-m', 'merge', 'feat/merged']);
    expect(await names()).toEqual(['feat/merged:ancestor']);
  });

  it('leaves a branch with real unlanded work alone, and counts it', async () => {
    commitOn('feat/live', 'c.txt', 'unlanded\n');
    const scan = await findLandedBranches(scratch.repo, 'main');
    expect(scan.landed).toEqual([]);
    expect(scan.keptCount).toBe(1);
  });

  it('is revert-safe: a reverted squash-merge stops reading as landed', async () => {
    commitOn('feat/reverted', 'd.txt', 'work\n');
    git(scratch.repo, ['merge', '-q', '--squash', 'feat/reverted']);
    git(scratch.repo, ['commit', '-qm', 'work (#2)']);
    expect(await names()).toEqual(['feat/reverted:content']);
    git(scratch.repo, ['revert', '--no-edit', 'HEAD']);
    // Merging it again WOULD change the tree, so it is not landed
    expect(await names()).toEqual([]);
  });

  it('never offers the base, or anything explicitly protected', async () => {
    commitOn('feat/x', 'e.txt', 'work\n');
    git(scratch.repo, ['merge', '-q', '--squash', 'feat/x']);
    git(scratch.repo, ['commit', '-qm', 'x (#3)']);
    git(scratch.repo, ['branch', 'integration/main']);
    const scan = await findLandedBranches(scratch.repo, 'main', [
      'integration/main',
    ]);
    expect(scan.landed.map((b) => b.name)).toEqual(['feat/x']);
  });

  it('reports the checkout holding a branch instead of trying to delete it', async () => {
    commitOn('feat/held', 'f.txt', 'work\n');
    git(scratch.repo, ['merge', '-q', '--squash', 'feat/held']);
    git(scratch.repo, ['commit', '-qm', 'held (#4)']);
    const wt = path.join(scratch.root, 'held');
    git(scratch.repo, ['worktree', 'add', '-q', wt, 'feat/held']);

    const scan = await findLandedBranches(scratch.repo, 'main');
    expect(scan.landed[0]?.worktree).toBe(wt);

    const outcome = await pruneLandedBranches(scratch.repo, 'main', [
      'feat/held',
    ]);
    expect(outcome.deleted).toEqual([]);
    expect(outcome.failed.get('feat/held')).toContain('checked out at');
    // The branch is still there
    expect(git(scratch.repo, ['rev-parse', '--verify', 'feat/held'])).toBeTruthy();
  });

  it('deletes what it proved, and says which were still published', async () => {
    commitOn('feat/gone', 'g.txt', 'work\n');
    git(scratch.repo, ['merge', '-q', '--squash', 'feat/gone']);
    git(scratch.repo, ['commit', '-qm', 'gone (#5)']);
    const outcome = await pruneLandedBranches(scratch.repo, 'main', [
      'feat/gone',
    ]);
    expect(outcome.deleted).toEqual(['feat/gone']);
    expect(outcome.failed.size).toBe(0);
    expect(() =>
      git(scratch.repo, ['rev-parse', '--verify', 'feat/gone']),
    ).toThrow();
  });

  it('re-verifies at delete time — a branch that moved is not deleted', async () => {
    commitOn('feat/moved', 'h.txt', 'work\n');
    git(scratch.repo, ['merge', '-q', '--squash', 'feat/moved']);
    git(scratch.repo, ['commit', '-qm', 'moved (#6)']);
    expect(await names()).toEqual(['feat/moved:content']);
    // ...an agent commits to it while the confirmation dialog is open
    const wt = path.join(scratch.root, 'moved');
    git(scratch.repo, ['worktree', 'add', '-q', wt, 'feat/moved']);
    fs.writeFileSync(path.join(wt, 'late.txt'), 'newer work\n');
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-qm', 'late work']);
    git(scratch.repo, ['worktree', 'remove', '--force', wt]);

    const outcome = await pruneLandedBranches(scratch.repo, 'main', [
      'feat/moved',
    ]);
    expect(outcome.deleted).toEqual([]);
    expect(outcome.failed.get('feat/moved')).toContain('no longer landed');
    expect(git(scratch.repo, ['rev-parse', '--verify', 'feat/moved'])).toBeTruthy();
  });
});
