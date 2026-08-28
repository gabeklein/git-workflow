import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { landedPrefix } from '../../src/git/preview/status';
import { startBaseMerge, startLaneRebase } from '../../src/git/laneOps';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Catching a STACKED lane up after its parent squash-merged. This is the
 * case plain `git rebase <base>` gets wrong: the parent's work is in the
 * base as one new commit, but the lane still carries the originals, so
 * base..HEAD lists them and rebase replays them into conflicts that are
 * not real disputes.
 */
describe('catch-up after a squash merge', () => {
  let scratch: ScratchRepo;
  let lane: string;

  const read = (root: string, f: string) =>
    fs.readFileSync(path.join(root, f), 'utf8');

  beforeEach(() => {
    scratch = makeRepo();
    // parent: two commits touching the same file the child will touch
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/parent']);
    fs.writeFileSync(path.join(scratch.repo, 'app.txt'), 'base\nparent one\n');
    git(scratch.repo, ['commit', '-qam', 'parent one']);
    fs.writeFileSync(
      path.join(scratch.repo, 'app.txt'),
      'base\nparent one\nparent two\n',
    );
    git(scratch.repo, ['commit', '-qam', 'parent two']);
    // child stacked on the parent
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/child']);
    fs.writeFileSync(
      path.join(scratch.repo, 'app.txt'),
      'base\nparent one\nparent two\nchild\n',
    );
    git(scratch.repo, ['commit', '-qam', 'child work']);
    // main squash-merges the parent: same content, brand new sha
    git(scratch.repo, ['checkout', '-q', 'main']);
    git(scratch.repo, ['merge', '-q', '--squash', 'feat/parent']);
    git(scratch.repo, ['commit', '-qm', 'parent work (#1)']);
    // ...and the parent branch is deleted, as a merged PR's branch is
    git(scratch.repo, ['branch', '-D', 'feat/parent']);
    lane = path.join(scratch.root, 'child');
    git(scratch.repo, ['worktree', 'add', '-q', lane, 'feat/child']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  const mainSha = () => git(scratch.repo, ['rev-parse', 'main']);

  it('finds the fork point by content, with the parent branch gone', async () => {
    const head = git(lane, ['rev-parse', 'HEAD']);
    const fork = await landedPrefix(lane, head, mainSha());
    // The parent's SECOND commit: everything up to there is in main
    expect(fork).toBe(git(lane, ['rev-parse', 'HEAD~1']));
  });

  it('replays only the unlanded commit — no phantom conflicts', async () => {
    expect(await startLaneRebase(lane, 'main')).toEqual({ status: 'done' });
    expect(git(lane, ['log', '--format=%s', 'main..HEAD'])).toBe('child work');
    expect(read(lane, 'app.txt')).toBe('base\nparent one\nparent two\nchild\n');
    // and the lane is genuinely on top of main now
    expect(
      git(lane, ['rev-parse', 'HEAD~1']),
    ).toBe(mainSha());
  });

  it('refuses the merge instead of handing over an unresolvable conflict', async () => {
    const before = git(lane, ['rev-parse', 'HEAD']);
    const result = await startBaseMerge(lane, 'main', 'feat/child');
    expect(result).toMatchObject({ status: 'blocked' });
    expect(result).toHaveProperty(
      'message',
      expect.stringContaining('rebase instead'),
    );
    expect(git(lane, ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(lane, ['status', '--porcelain'])).toBe('');
  });

  it('leaves an ordinary lane alone — no fork point, plain rebase', async () => {
    // A lane cut straight from main has nothing already landed
    git(scratch.repo, ['branch', 'feat/plain', 'main']);
    const plain = path.join(scratch.root, 'plain');
    git(scratch.repo, ['worktree', 'add', '-q', plain, 'feat/plain']);
    fs.writeFileSync(path.join(plain, 'new.txt'), 'fresh\n');
    git(plain, ['add', '-A']);
    git(plain, ['commit', '-qm', 'fresh work']);
    expect(
      await landedPrefix(plain, git(plain, ['rev-parse', 'HEAD']), mainSha()),
    ).toBeUndefined();
    expect(await startLaneRebase(plain, 'main')).toEqual({ status: 'done' });
    expect(git(plain, ['log', '--format=%s', 'main..HEAD'])).toBe('fresh work');
  });

  it('reports nothing when the whole branch already landed', async () => {
    // A fully-landed lane is retirement's problem, not catch-up's
    git(scratch.repo, ['branch', 'feat/done', 'feat/child']);
    const done = path.join(scratch.root, 'done');
    git(scratch.repo, ['worktree', 'add', '-q', done, 'feat/done']);
    git(scratch.repo, ['checkout', '-q', 'main']);
    // -X theirs: main already carries the parent's work under a different
    // sha, so the textual merge sees a clash that content-wise is not one.
    // The tree that results is child's, which is what squashing the PR
    // actually produces.
    git(scratch.repo, ['merge', '-q', '--squash', '-X', 'theirs', 'feat/child']);
    git(scratch.repo, ['commit', '-qm', 'child work (#2)']);
    expect(
      await landedPrefix(done, git(done, ['rev-parse', 'HEAD']), mainSha()),
    ).toBeUndefined();
  });
});
