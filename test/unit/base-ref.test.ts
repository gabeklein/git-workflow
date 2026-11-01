import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git, makeRepo, type ScratchRepo } from './helpers';
import {
  inferBaseRef,
  preferRemoteTrackingRef,
  resolveBaseRef,
} from '../../src/git/baseRef';
import { BaseStatusTracker } from '../../src/views/baseStatusTracker';
import type { DiscoveredWorktree } from '../../src/git/discovery';

/**
 * The compare base decides what every diff, badge and catch-up measures
 * against, and a wrong one fails quietly: an empty diff, or a lane that
 * looks hundreds of commits ahead. What is pinned here is the order of the
 * evidence — an open PR's base first, because GitHub is where the branch
 * is going — and the two sources that used to win while saying nothing:
 * a PR head fetched for review, and a branch's own remote copy.
 */

let r: ScratchRepo;

afterEach(() => r?.cleanup());

/** Push a branch to origin from the landing clone, then fetch it here. */
function publish(branch: string, from = 'main'): void {
  git(r.landing, ['fetch', '-q', 'origin']);
  git(r.landing, ['checkout', '-q', '-b', branch, `origin/${from}`]);
  const file = `${branch.replace(/\//g, '-')}.txt`;
  fs.writeFileSync(path.join(r.landing, file), branch);
  git(r.landing, ['add', '-A']);
  git(r.landing, ['commit', '-qm', branch]);
  git(r.landing, ['push', '-q', 'origin', branch]);
  git(r.landing, ['checkout', '-q', '--detach']);
  git(r.repo, ['fetch', '-q', 'origin']);
}

function worktree(name: string, args: string[]): string {
  const dir = path.join(r.root, name);
  const start = args.at(-1)!;
  git(r.repo, ['worktree', 'add', '-q', ...args.slice(0, -1), dir, start]);
  return dir;
}

describe('compare base resolution', () => {
  it('never takes a PR head fetched for review as the base', async () => {
    r = makeRepo({ withOrigin: true });
    publish('release');
    publish('feat', 'release');
    // What Check Out PR does: fetch the head into refs/remotes/pr/<n> and
    // branch from it, so the reflog says "Created from refs/remotes/pr/7"
    git(r.repo, ['fetch', '-q', 'origin', 'feat:refs/remotes/pr/7']);
    const wt = worktree('pr-7', ['-b', 'feat', 'refs/remotes/pr/7']);

    expect(await inferBaseRef(wt)).toBeUndefined();
    expect(await resolveBaseRef(wt, 'main')).toBe('origin/main');
    // With the PR known, its base is the answer
    expect(await resolveBaseRef(wt, 'main', 'release')).toBe('origin/release');
  });

  it("a remote-only checkout follows its PR's base, not the default", async () => {
    r = makeRepo({ withOrigin: true });
    publish('release');
    publish('feat', 'release');
    // Reflog and upstream both name origin/feat — the branch itself
    const wt = worktree('feat', ['-b', 'feat', 'origin/feat']);

    expect(await inferBaseRef(wt)).toBeUndefined();
    expect(await resolveBaseRef(wt, 'main', 'release')).toBe('origin/release');
    expect(await inferBaseRef(wt, 'release')).toBe('origin/release');
  });

  it('an open PR base outranks a stale vscode-merge-base', async () => {
    r = makeRepo({ withOrigin: true });
    publish('release');
    const wt = worktree('feat', ['-b', 'feat', 'origin/main']);
    git(wt, ['config', 'branch.feat.vscode-merge-base', 'origin/main']);

    expect(await resolveBaseRef(wt, 'main')).toBe('origin/main');
    expect(await resolveBaseRef(wt, 'main', 'release')).toBe('origin/release');
    // Outranked, not rewritten: the config is left as it was
    expect(git(wt, ['config', 'branch.feat.vscode-merge-base'])).toBe(
      'origin/main',
    );
  });

  it('a PR base with no ref here falls through to inference', async () => {
    r = makeRepo({ withOrigin: true });
    publish('release');
    const wt = worktree('feat', ['-b', 'feat', 'origin/release']);

    expect(await resolveBaseRef(wt, 'main', 'never-fetched')).toBe(
      'origin/release',
    );
  });

  it('upgrades slash-named locals to their remote tip, leaves remote refs alone', async () => {
    r = makeRepo({ withOrigin: true });
    publish('release/2.0');
    git(r.repo, ['branch', 'release/2.0', 'origin/release/2.0']);
    git(r.repo, ['branch', 'local/only']);
    git(r.repo, ['remote', 'add', 'fork', r.origin]);
    git(r.repo, ['fetch', '-q', 'fork']);

    expect(await preferRemoteTrackingRef(r.repo, 'release/2.0')).toBe(
      'origin/release/2.0',
    );
    expect(await preferRemoteTrackingRef(r.repo, 'main')).toBe('origin/main');
    expect(await preferRemoteTrackingRef(r.repo, 'origin/main')).toBe(
      'origin/main',
    );
    expect(await preferRemoteTrackingRef(r.repo, 'fork/main')).toBe(
      'fork/main',
    );
    expect(
      await preferRemoteTrackingRef(r.repo, 'refs/remotes/origin/main'),
    ).toBe('refs/remotes/origin/main');
    expect(await preferRemoteTrackingRef(r.repo, 'local/only')).toBe(
      'local/only',
    );
  });
});

describe('BaseStatusTracker follows the PR', () => {
  it('re-resolves when the open PR base changes, without a refresh', async () => {
    r = makeRepo({ withOrigin: true });
    publish('release');
    publish('staging');
    const wt = worktree('feat', ['-b', 'feat', 'origin/main']);
    const rows: DiscoveredWorktree[] = [
      { path: wt, name: 'feat', branch: 'feat', detached: false },
    ];
    let prBase: string | undefined;
    const tracker = new BaseStatusTracker({
      output: { appendLine: () => undefined },
      getWorktrees: () => rows,
      listedWorktrees: () => rows,
      fallbackBaseRef: () => 'main',
      pullRequestBaseFor: () => prBase,
      fireTreeData: () => undefined,
    });

    expect(await tracker.baseFor(wt)).toBe('origin/main');
    prBase = 'release';
    expect(await tracker.baseFor(wt)).toBe('origin/release');
    expect(await tracker.genuineBaseFor(wt)).toBe('origin/release');
    // Retargeted on GitHub
    prBase = 'staging';
    expect(await tracker.baseFor(wt)).toBe('origin/staging');
    // PR closed: back to what the branch itself says
    prBase = undefined;
    expect(await tracker.baseFor(wt)).toBe('origin/main');
    // A manual override still outranks the PR
    prBase = 'release';
    await tracker.setOverride(wt, 'staging');
    expect(await tracker.baseFor(wt)).toBe('origin/staging');
  });

  it("drops a manual base on leaving a lane whose PR names one, and keeps it otherwise", async () => {
    r = makeRepo({ withOrigin: true });
    publish('release');
    publish('staging');
    const wt = worktree('feat', ['-b', 'feat', 'origin/main']);
    const rows: DiscoveredWorktree[] = [
      { path: wt, name: 'feat', branch: 'feat', detached: false },
    ];
    let prBase: string | undefined = 'release';
    const tracker = new BaseStatusTracker({
      output: { appendLine: () => undefined },
      getWorktrees: () => rows,
      listedWorktrees: () => rows,
      fallbackBaseRef: () => 'main',
      pullRequestBaseFor: () => prBase,
      fireTreeData: () => undefined,
    });

    await tracker.setOverride(wt, 'staging');
    expect(tracker.dropOverrideOnLeave(wt)).toBe(true);
    expect(tracker.getOverride(wt)).toBeUndefined();
    expect(await tracker.baseFor(wt)).toBe('origin/release');
    expect(tracker.dropOverrideOnLeave(wt)).toBe(false);

    // No PR: the manual base is the only answer, so it stays
    prBase = undefined;
    await tracker.setOverride(wt, 'staging');
    expect(tracker.dropOverrideOnLeave(wt)).toBe(false);
    expect(await tracker.baseFor(wt)).toBe('origin/staging');
  });
});
