import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncBranchWithRemote } from '../../src/git/syncRemote';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Sync reconciles a branch with ITS OWN upstream. The two unambiguous
 * directions move on their own; the ambiguous one must refuse, because
 * guessing there is how pushed work disappears.
 */
describe('sync with remote', () => {
  let scratch: ScratchRepo;

  const commit = (cwd: string, file: string, body: string, msg: string) => {
    fs.writeFileSync(path.join(cwd, file), body);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-qm', msg]);
  };

  beforeEach(() => {
    scratch = makeRepo({ withOrigin: true });
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/x']);
    commit(scratch.repo, 'x.txt', 'one\n', 'x one');
    git(scratch.repo, ['push', '-q', '-u', 'origin', 'feat/x']);
    git(scratch.repo, ['checkout', '-q', 'main']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  /** Land a commit on origin's copy of feat/x, from the other clone. */
  const pushFromElsewhere = () => {
    git(scratch.landing, ['fetch', '-q', 'origin']);
    git(scratch.landing, ['checkout', '-q', '-B', 'feat/x', 'origin/feat/x']);
    commit(scratch.landing, 'remote.txt', 'theirs\n', 'their work');
    git(scratch.landing, ['push', '-q', 'origin', 'feat/x']);
  };

  it('reports up to date when the sides agree', async () => {
    expect(await syncBranchWithRemote(scratch.repo, 'feat/x')).toEqual({
      status: 'up-to-date',
    });
  });

  it('publishes a branch that origin has never seen', async () => {
    git(scratch.repo, ['branch', 'feat/fresh']);
    expect(await syncBranchWithRemote(scratch.repo, 'feat/fresh')).toEqual({
      status: 'published',
      branch: 'feat/fresh',
    });
    expect(
      git(scratch.repo, ['rev-parse', 'origin/feat/fresh']),
    ).toBe(git(scratch.repo, ['rev-parse', 'feat/fresh']));
  });

  it('pushes when only local is ahead', async () => {
    const wt = path.join(scratch.root, 'x');
    git(scratch.repo, ['worktree', 'add', '-q', wt, 'feat/x']);
    commit(wt, 'x.txt', 'two\n', 'x two');
    expect(await syncBranchWithRemote(scratch.repo, 'feat/x', wt)).toEqual({
      status: 'pushed',
      ahead: 1,
    });
    expect(git(scratch.repo, ['rev-parse', 'origin/feat/x'])).toBe(
      git(wt, ['rev-parse', 'HEAD']),
    );
  });

  it('fast-forwards a CHECKED OUT branch inside its worktree', async () => {
    const wt = path.join(scratch.root, 'x');
    git(scratch.repo, ['worktree', 'add', '-q', wt, 'feat/x']);
    pushFromElsewhere();
    expect(await syncBranchWithRemote(scratch.repo, 'feat/x', wt)).toEqual({
      status: 'fast-forwarded',
      behind: 1,
    });
    expect(fs.existsSync(path.join(wt, 'remote.txt'))).toBe(true);
  });

  it('fast-forwards a branch with NO checkout, which merge cannot reach', async () => {
    pushFromElsewhere();
    expect(await syncBranchWithRemote(scratch.repo, 'feat/x')).toEqual({
      status: 'fast-forwarded',
      behind: 1,
    });
    expect(git(scratch.repo, ['rev-parse', 'feat/x'])).toBe(
      git(scratch.repo, ['rev-parse', 'origin/feat/x']),
    );
  });

  it('REFUSES when both sides moved, and touches nothing', async () => {
    const wt = path.join(scratch.root, 'x');
    git(scratch.repo, ['worktree', 'add', '-q', wt, 'feat/x']);
    commit(wt, 'mine.txt', 'mine\n', 'my work');
    pushFromElsewhere();
    const localBefore = git(wt, ['rev-parse', 'HEAD']);

    const result = await syncBranchWithRemote(scratch.repo, 'feat/x', wt);
    expect(result).toEqual({ status: 'diverged', ahead: 1, behind: 1 });

    // Neither side moved — no merge commit, and origin still has theirs
    expect(git(wt, ['rev-parse', 'HEAD'])).toBe(localBefore);
    expect(git(scratch.repo, ['log', '-1', '--format=%s', 'origin/feat/x'])).toBe(
      'their work',
    );
    expect(git(wt, ['status', '--porcelain'])).toBe('');
  });

  it('refuses rather than clobbering uncommitted work on a fast-forward', async () => {
    const wt = path.join(scratch.root, 'x');
    git(scratch.repo, ['worktree', 'add', '-q', wt, 'feat/x']);
    pushFromElsewhere();
    // Local edit to the very file the fast-forward would bring in
    fs.writeFileSync(path.join(wt, 'remote.txt'), 'mine, uncommitted\n');
    const result = await syncBranchWithRemote(scratch.repo, 'feat/x', wt);
    expect(result).toMatchObject({ status: 'error' });
    expect(fs.readFileSync(path.join(wt, 'remote.txt'), 'utf8')).toBe(
      'mine, uncommitted\n',
    );
  });

  it('says so when there is no remote at all', async () => {
    const solo = makeRepo();
    try {
      git(solo.repo, ['branch', 'feat/solo']);
      expect(await syncBranchWithRemote(solo.repo, 'feat/solo')).toEqual({
        status: 'no-remote',
      });
    } finally {
      solo.cleanup();
    }
  });
});
