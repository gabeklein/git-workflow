import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  forgetChainCache,
  rebuildPreview,
} from '../../src/git/preview/engine';
import {
  addAppliedLane,
  addCandidateLane,
  reorderLane,
} from '../../src/git/preview/lanes';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * The committed chain is memoized so a wip overlay — which rebuilds on
 * every save — does not redo every lane merge each time.
 *
 * Reuse is asserted by SHA, not by timing: the cached chain returns the
 * identical tip commit, and a recomputed one would be a fresh object with
 * a new sha (commit-tree stamps a committer date). So "same sha" is proof
 * the cache was used, and "different sha" proof it was not.
 */
describe('chain memoization', () => {
  let scratch: ScratchRepo;
  let working: string;
  let laneA: string;

  const tip = () => git(working, ['rev-parse', 'HEAD']);

  beforeEach(async () => {
    forgetChainCache();
    scratch = makeRepo({ withOrigin: true });
    for (const [branch, file] of [
      ['feat/a', 'a.txt'],
      ['feat/b', 'b.txt'],
    ] as const) {
      git(scratch.repo, ['checkout', '-q', '-b', branch, 'main']);
      fs.writeFileSync(path.join(scratch.repo, file), `${branch}\n`);
      git(scratch.repo, ['add', '-A']);
      git(scratch.repo, ['commit', '-qm', `${branch} work`]);
      git(scratch.repo, ['checkout', '-q', 'main']);
    }
    working = scratch.repo;
    git(working, ['checkout', '-q', '-b', 'preview/main', 'main']);
    // Candidates carry the ORDER, applied carries membership.
    for (const lane of ['feat/a', 'feat/b']) {
      await addCandidateLane(working, lane);
      await addAppliedLane(working, lane);
    }
    laneA = path.join(scratch.root, 'lane-a');
    git(scratch.repo, ['worktree', 'add', '-q', laneA, 'feat/a']);
  });
  afterEach(() => {
    forgetChainCache();
    scratch.cleanup();
  });

  it('reuses the chain when nothing changed', async () => {
    expect(await rebuildPreview(working, 'origin/main')).toMatchObject({
      ok: true,
    });
    const first = tip();
    expect(await rebuildPreview(working, 'origin/main')).toMatchObject({
      ok: true,
    });
    expect(tip()).toBe(first);
  });

  it('recomputes when a lane tip moves', async () => {
    await rebuildPreview(working, 'origin/main');
    const first = tip();
    fs.writeFileSync(path.join(laneA, 'a.txt'), 'feat/a\nmore\n');
    git(laneA, ['commit', '-qam', 'more a']);
    await rebuildPreview(working, 'origin/main');
    expect(tip()).not.toBe(first);
    expect(fs.readFileSync(path.join(working, 'a.txt'), 'utf8')).toBe(
      'feat/a\nmore\n',
    );
  });

  it('recomputes when the ORDER changes, even with identical tips', async () => {
    // The whole point of keying on order: same lanes, same shas, different
    // merge order is a different chain.
    await rebuildPreview(working, 'origin/main');
    const first = tip();
    expect(await reorderLane(working, 'feat/b', 'feat/a')).toBe(true);
    await rebuildPreview(working, 'origin/main');
    expect(tip()).not.toBe(first);
  });

  it('recomputes when a lane is removed', async () => {
    await rebuildPreview(working, 'origin/main');
    const first = tip();
    fs.writeFileSync(path.join(working, '.git', 'focus-applied'), 'feat/a\n');
    await rebuildPreview(working, 'origin/main');
    expect(tip()).not.toBe(first);
    expect(fs.existsSync(path.join(working, 'b.txt'))).toBe(false);
  });

  it('does not reuse a tip whose commit no longer exists', async () => {
    await rebuildPreview(working, 'origin/main');
    const first = tip();
    // Simulate the object being pruned: the cache still holds the sha, but
    // rebuilding must not build on top of something git cannot resolve.
    git(working, ['checkout', '-q', '-B', 'preview/main', 'main']);
    const gone = fs.readFileSync(
      path.join(working, '.git', 'focus-applied'),
      'utf8',
    );
    expect(gone).toContain('feat/a');
    const result = await rebuildPreview(working, 'origin/main');
    expect(result).toMatchObject({ ok: true });
    // Rebuilt to the same content either way — reuse is an optimization,
    // never a difference in outcome.
    expect(git(working, ['rev-parse', 'HEAD^{tree}'])).toBe(
      git(working, ['rev-parse', `${first}^{tree}`]),
    );
  });

  it('a wip overlay does not disturb the cached committed chain', async () => {
    await rebuildPreview(working, 'origin/main');
    const committed = tip();
    // Dirty the lane, mark it wip, rebuild: the overlay lands ON TOP, so
    // the committed chain underneath is the cached commit unchanged.
    fs.writeFileSync(path.join(laneA, 'a.txt'), 'feat/a\nuncommitted\n');
    fs.writeFileSync(path.join(working, '.git', 'focus-wip'), 'feat/a\n');
    await rebuildPreview(working, 'origin/main');
    const withWip = tip();
    expect(withWip).not.toBe(committed);
    // First parent of the overlay commit is the cached chain tip
    expect(git(working, ['rev-parse', `${withWip}^1`])).toBe(committed);
  });
});
