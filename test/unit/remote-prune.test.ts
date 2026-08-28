import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hasOrigin,
  parsePruneOutput,
  pruneTrackingRefs,
  staleTrackingRefs,
} from '../../src/git/remotePrune';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Remote-tracking refs outliving the branches they track.
 *
 * The bug: every fetch in this extension is a targeted refspec and
 * `git pull` does not prune, so a branch deleted on the remote — what a
 * merged PR does by default — leaves `origin/<name>` behind forever and
 * the Remote group lists a branch that no longer exists.
 */
describe('parsePruneOutput', () => {
  it('reads the real run and the dry run alike', () => {
    // Both markers, because the dry run is what a caller uses to ask
    // WITHOUT writing, and a parser that only knows one silently reports
    // nothing for the other.
    expect(
      parsePruneOutput(
        [
          'Pruning origin',
          'URL: git@github.com:gabeklein/git-workflow.git',
          ' * [pruned] origin/feat/agent-skill',
          ' * [pruned] origin/refactor/preview',
        ].join('\n'),
      ),
    ).toEqual(['feat/agent-skill', 'refactor/preview']);

    expect(
      parsePruneOutput(
        [
          'Pruning origin',
          'URL: git@github.com:gabeklein/git-workflow.git',
          ' * [would prune] origin/fix/install-honest',
        ].join('\n'),
      ),
    ).toEqual(['fix/install-honest']);
  });

  it('takes nothing from a run that pruned nothing', () => {
    // The header is always printed — treating it as data would report a
    // ghost named "origin" on every tick.
    expect(
      parsePruneOutput('Pruning origin\nURL: git@github.com:x/y.git'),
    ).toEqual([]);
  });
});

describe('pruning a real remote', () => {
  let scratch: ScratchRepo;

  beforeEach(() => {
    scratch = makeRepo({ withOrigin: true });
    // A branch that exists on both sides, as a landed PR's head would
    git(scratch.repo, ['branch', 'feat/landed']);
    git(scratch.repo, ['push', '-q', 'origin', 'feat/landed']);
    git(scratch.repo, ['branch', 'feat/live']);
    git(scratch.repo, ['push', '-q', 'origin', 'feat/live']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  const remoteRefs = () =>
    git(scratch.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
      .split('\n')
      .filter(Boolean);

  it('finds an origin to prune', async () => {
    expect(await hasOrigin(scratch.repo)).toBe(true);
  });

  /**
   * Delete the branch INSIDE origin, the way merging a PR does.
   *
   * Not `git push origin --delete`: that drops the local tracking ref as a
   * side effect, so it cannot produce the state under test. The ghost
   * exists precisely because the deletion happened somewhere else.
   */
  const deleteOnRemote = (branch: string) =>
    git(scratch.origin, ['branch', '-D', branch]);

  it('drops the tracking ref of a branch deleted on the remote', async () => {
    deleteOnRemote('feat/landed');
    // The bug: a targeted fetch leaves the ghost standing
    git(scratch.repo, ['fetch', '-q', 'origin', 'main']);
    expect(remoteRefs()).toContain('origin/feat/landed');

    expect(await staleTrackingRefs(scratch.repo)).toEqual(['feat/landed']);
    expect(await pruneTrackingRefs(scratch.repo)).toEqual(['feat/landed']);
    expect(remoteRefs()).not.toContain('origin/feat/landed');
    // ...and the branch that IS still on the remote keeps its ref
    expect(remoteRefs()).toContain('origin/feat/live');
  });

  it('leaves the local branch and its commits alone', async () => {
    const tip = git(scratch.repo, ['rev-parse', 'feat/landed']);
    deleteOnRemote('feat/landed');
    await pruneTrackingRefs(scratch.repo);
    // Pruning is a cache eviction, not a deletion: this is what makes it
    // safe to run on a background tick.
    expect(git(scratch.repo, ['rev-parse', 'feat/landed'])).toBe(tip);
  });

  it('reports nothing when every tracking ref is real', async () => {
    expect(await pruneTrackingRefs(scratch.repo)).toEqual([]);
  });

  it('is quiet when there is no remote at all', async () => {
    const solo = makeRepo();
    try {
      expect(await hasOrigin(solo.repo)).toBe(false);
      // Not an error — an unpublished repo is a normal state
      expect(await pruneTrackingRefs(solo.repo)).toEqual([]);
    } finally {
      solo.cleanup();
    }
  });
});
