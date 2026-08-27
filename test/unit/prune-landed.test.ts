import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findLandedBranches,
  pruneLandedBranches,
} from '../../src/git/pruneLanded';
import { forgetLandedProbe, landedVia } from '../../src/git/landedProbe';
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

/**
 * The case the first version got wrong: a branch that landed a while ago,
 * with the base moving on afterwards. Merging it into the base now
 * conflicts on files later work also touched, so a "would this merge
 * change anything" probe reports not-landed and the branch survives
 * forever — which is precisely the crust the prune exists to clear.
 */
describe('prune landed branches — stale landings', () => {
  let scratch: ScratchRepo;

  const write = (f: string, body: string) => {
    fs.writeFileSync(path.join(scratch.repo, f), body);
    git(scratch.repo, ['add', '-A']);
  };

  beforeEach(() => {
    scratch = makeRepo();
    write('app.txt', 'one\ntwo\nthree\n');
    git(scratch.repo, ['commit', '-qm', 'app']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('finds a squash landing the base has since moved past', async () => {
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/old', 'main']);
    write('app.txt', 'one\nBRANCH\nthree\n');
    git(scratch.repo, ['commit', '-qm', 'branch edit']);
    git(scratch.repo, ['checkout', '-q', 'main']);
    git(scratch.repo, ['merge', '-q', '--squash', 'feat/old']);
    git(scratch.repo, ['commit', '-qm', 'branch edit (#1)']);
    // ...and then the base keeps going, touching the SAME line
    write('app.txt', 'one\nBRANCH\nthree\nlater work\n');
    git(scratch.repo, ['commit', '-qm', 'later (#2)']);
    write('app.txt', 'one\nBRANCH AGAIN\nthree\nlater work\n');
    git(scratch.repo, ['commit', '-qm', 'later still (#3)']);

    const scan = await findLandedBranches(scratch.repo, 'main');
    expect(scan.landed.map((b) => `${b.name}:${b.via}`)).toEqual([
      'feat/old:squash',
    ]);
  });

  it('still refuses a stale branch whose work was reverted', async () => {
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/undone', 'main']);
    write('app.txt', 'one\nUNDONE\nthree\n');
    git(scratch.repo, ['commit', '-qm', 'work']);
    git(scratch.repo, ['checkout', '-q', 'main']);
    git(scratch.repo, ['merge', '-q', '--squash', 'feat/undone']);
    git(scratch.repo, ['commit', '-qm', 'work (#1)']);
    git(scratch.repo, ['revert', '--no-edit', 'HEAD']);
    write('other.txt', 'unrelated\n');
    git(scratch.repo, ['commit', '-qm', 'moving on (#2)']);

    // The squash is still in history — a history-based test would say
    // landed. The work is not in the tree, so this must not.
    const scan = await findLandedBranches(scratch.repo, 'main');
    expect(scan.landed).toEqual([]);
    expect(scan.keptCount).toBe(1);
  });

  it('keeps a branch whose work never landed at all', async () => {
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/live', 'main']);
    write('app.txt', 'one\nLIVE\nthree\n');
    git(scratch.repo, ['commit', '-qm', 'live work']);
    git(scratch.repo, ['checkout', '-q', 'main']);
    write('app.txt', 'one\ntwo\nthree\nmain moved\n');
    git(scratch.repo, ['commit', '-qm', 'main (#1)']);

    const scan = await findLandedBranches(scratch.repo, 'main');
    expect(scan.landed).toEqual([]);
  });
});

/**
 * The probe is memoized because retirement calls it on every rebuild, once
 * per lane — enough repeated work to push a rebuild past a CI poll. The
 * key is (repo, branch sha, base sha), which fully determines the answer,
 * so an entry cannot go stale: a revert or a new base commit is a
 * different base sha and therefore a different key.
 */
describe('landed probe memo', () => {
  let scratch: ScratchRepo;

  beforeEach(() => {
    forgetLandedProbe();
    scratch = makeRepo();
  });
  afterEach(() => {
    forgetLandedProbe();
    scratch.cleanup();
  });

  it('gives the same answer twice, and notices a new base', async () => {
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/x', 'main']);
    fs.writeFileSync(path.join(scratch.repo, 'x.txt'), 'work\n');
    git(scratch.repo, ['add', '-A']);
    git(scratch.repo, ['commit', '-qm', 'x work']);
    git(scratch.repo, ['checkout', '-q', 'main']);
    const lane = git(scratch.repo, ['rev-parse', 'feat/x']);

    const before = git(scratch.repo, ['rev-parse', 'main']);
    expect(await landedVia(scratch.repo, lane, before)).toBeUndefined();
    expect(await landedVia(scratch.repo, lane, before)).toBeUndefined();

    // Land it: a NEW base sha, so a new key — the cached "not landed"
    // answer for the old base cannot mask it.
    git(scratch.repo, ['merge', '-q', '--squash', 'feat/x']);
    git(scratch.repo, ['commit', '-qm', 'x work (#1)']);
    const after = git(scratch.repo, ['rev-parse', 'main']);
    expect(await landedVia(scratch.repo, lane, after)).toBeTruthy();
  });
});
