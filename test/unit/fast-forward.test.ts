import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fastForwardEmptyLane } from '../../src/git/laneOps';
import { addBranch, git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Re-pointing an empty lane at the base. A branch with no commits of its
 * own reads as "behind" while having nothing to rebase, so the fix is to
 * move it — which is only ever safe while it stays empty.
 */
describe('fastForwardEmptyLane', () => {
  let scratch: ScratchRepo;
  let lane: string;

  beforeEach(() => {
    scratch = makeRepo({ withOrigin: true });
    // A worktree cut from main BEFORE the base moves on
    git(scratch.repo, ['branch', 'feat/fresh', 'main']);
    lane = path.join(scratch.root, 'lane');
    git(scratch.repo, ['worktree', 'add', '-q', lane, 'feat/fresh']);
    // origin/main advances past it
    git(scratch.landing, ['fetch', '-q', 'origin']);
    fs.writeFileSync(path.join(scratch.landing, 'new.txt'), 'landed later\n');
    git(scratch.landing, ['add', '-A']);
    git(scratch.landing, ['commit', '-qm', 'base moves on']);
    git(scratch.landing, ['push', '-q']);
    git(scratch.repo, ['fetch', '-q', 'origin']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  const behind = () =>
    Number(
      git(scratch.repo, [
        'rev-list',
        '--count',
        'feat/fresh..origin/main',
      ]),
    );

  it('moves a stale empty lane onto the base, working tree and all', async () => {
    expect(behind()).toBe(1);
    const result = await fastForwardEmptyLane(lane, 'origin/main');
    expect(result).toEqual({ status: 'done' });
    expect(behind()).toBe(0);
    expect(git(scratch.repo, ['rev-parse', 'feat/fresh'])).toBe(
      git(scratch.repo, ['rev-parse', 'origin/main']),
    );
    expect(fs.existsSync(path.join(lane, 'new.txt'))).toBe(true);
  });

  it('is a no-op once the lane already sits on the base', async () => {
    await fastForwardEmptyLane(lane, 'origin/main');
    expect(await fastForwardEmptyLane(lane, 'origin/main')).toEqual({
      status: 'done',
    });
  });

  // The whole safety argument is "there are no commits to lose" — so the
  // moment there are any, this must refuse and leave the ref alone.
  it('refuses a lane that has commits of its own', async () => {
    fs.writeFileSync(path.join(lane, 'work.txt'), 'real work\n');
    git(lane, ['add', '-A']);
    git(lane, ['commit', '-qm', 'lane work']);
    const tip = git(scratch.repo, ['rev-parse', 'feat/fresh']);
    const result = await fastForwardEmptyLane(lane, 'origin/main');
    expect(result).toMatchObject({ status: 'blocked' });
    expect(git(scratch.repo, ['rev-parse', 'feat/fresh'])).toBe(tip);
  });

  it('refuses a lane whose tip already landed via a merge', async () => {
    // Diverge, then land it — the tip becomes a merge second parent, which
    // is contained in the base but was never on its first-parent line.
    addBranch(scratch.repo, 'feat/landed', 'l.txt', 'landed\n');
    git(scratch.repo, ['push', '-q', 'origin', 'feat/landed']);
    const landedTip = git(scratch.repo, ['rev-parse', 'feat/landed']);
    git(scratch.landing, ['fetch', '-q', 'origin']);
    git(scratch.landing, [
      'merge', '-q', '--no-ff', '-m', 'Merge feat/landed', 'origin/feat/landed',
    ]);
    git(scratch.landing, ['push', '-q']);
    git(scratch.repo, ['fetch', '-q', 'origin']);
    const landedWt = path.join(scratch.root, 'landed-wt');
    git(scratch.repo, ['worktree', 'add', '-q', landedWt, 'feat/landed']);
    expect(await fastForwardEmptyLane(landedWt, 'origin/main')).toMatchObject({
      status: 'blocked',
    });
    expect(git(scratch.repo, ['rev-parse', 'feat/landed'])).toBe(landedTip);
  });

  it('refuses a dirty worktree — uncommitted work means it is not empty', async () => {
    fs.writeFileSync(path.join(lane, 'app.txt'), 'mid-edit\n');
    const result = await fastForwardEmptyLane(lane, 'origin/main');
    expect(result).toMatchObject({ status: 'blocked' });
    expect(behind()).toBe(1);
    expect(fs.readFileSync(path.join(lane, 'app.txt'), 'utf8')).toBe(
      'mid-edit\n',
    );
  });
});
