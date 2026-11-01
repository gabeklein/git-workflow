import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareRefToBase, listRecentCommits } from '../../src/git/compare';
import {
  describeRefFocus,
  ensureRefFocusFetched,
  parseStoredRefFocus,
  refExists,
  refFocusBase,
  refFocusForBranch,
} from '../../src/git/refFocus';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Focusing a branch that has no checkout: the Focus panel explores it
 * from its ref alone — commits and Full Diff against a base — fetching
 * the ref first when it is not here yet.
 */

/** Commit `file` on a new branch in `dir`, starting at `from`. */
function commitOn(
  dir: string,
  branch: string,
  from: string,
  files: Record<string, string>,
  message = `${branch} work`,
): void {
  git(dir, ['checkout', '-q', '-b', branch, from]);
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', message]);
  git(dir, ['checkout', '-q', '-']);
}

describe('refFocusForBranch', () => {
  it('prefers the local ref, then origin, then the PR head', () => {
    expect(
      refFocusForBranch({ branch: 'x', hasLocalRef: true, hasRemote: true }),
    ).toMatchObject({ ref: 'x', source: 'local' });
    expect(
      refFocusForBranch({ branch: 'x', hasLocalRef: false, hasRemote: true }),
    ).toMatchObject({ ref: 'origin/x', source: 'remote' });
    // A fork PR has no branch ref at all — only pull/<n>/head
    expect(
      refFocusForBranch({
        branch: 'x',
        hasLocalRef: false,
        hasRemote: false,
        pr: { number: 7, baseRefName: 'main' },
      }),
    ).toMatchObject({
      ref: 'refs/remotes/pr/7',
      source: 'pr',
      pr: { number: 7, baseRefName: 'main' },
    });
  });

  it('keeps the PR for its base even when a branch ref exists', () => {
    expect(
      refFocusForBranch({
        branch: 'x',
        hasRemote: true,
        pr: { number: 3, baseRefName: 'develop' },
      }),
    ).toMatchObject({ ref: 'origin/x', pr: { baseRefName: 'develop' } });
  });
});

describe('parseStoredRefFocus', () => {
  it('round-trips what focusRef stores', () => {
    const focus = refFocusForBranch({
      branch: 'feat/x',
      hasRemote: true,
      pr: { number: 9, baseRefName: 'main' },
    });
    expect(parseStoredRefFocus(JSON.parse(JSON.stringify(focus)))).toEqual(
      focus,
    );
  });

  // Workspace state written before refs could be focused has no such key,
  // and a malformed one must fall back to the checkout rather than throw
  // while the panel renders.
  it('reads absent or malformed state as no ref focus', () => {
    expect(parseStoredRefFocus(undefined)).toBeUndefined();
    expect(parseStoredRefFocus('/some/worktree/path')).toBeUndefined();
    expect(parseStoredRefFocus({ ref: 'origin/x' })).toBeUndefined();
    expect(
      parseStoredRefFocus({ ref: 'origin/x', branch: 'x', source: 'bogus' }),
    ).toBeUndefined();
    expect(
      parseStoredRefFocus({ ref: 'x', branch: 'x', source: 'local', pr: 'no' }),
    ).toEqual({ ref: 'x', branch: 'x', source: 'local', pr: undefined });
  });
});

describe('a focus with a base of its own', () => {
  // How the stacks layout focuses a stacked branch, a commit or a
  // combination: the base is fixed by whoever focused it.
  const focus = {
    ref: 'refs/gw/combined',
    branch: 'feat/a + feat/b',
    source: 'local' as const,
    pr: { number: 3, baseRefName: 'main' },
    base: 'abc123',
    label: '2 combined',
    conflicts: ['app.txt'],
    history: true,
    parts: ['feat/a', 'origin/feat/b'],
  };

  it('survives workspace state', () => {
    expect(parseStoredRefFocus(JSON.parse(JSON.stringify(focus)))).toEqual(focus);
    expect(
      parseStoredRefFocus({ ...focus, base: 7, label: '', conflicts: [1], history: 'yes', parts: ['only-one'] }),
    ).toEqual({
      ...focus,
      base: undefined,
      label: undefined,
      conflicts: undefined,
      history: undefined,
      parts: undefined,
    });
  });

  it('outranks the PR base, and names the panel', async () => {
    expect(await refFocusBase('/nowhere', focus, 'origin/main')).toBe('abc123');
    expect(describeRefFocus(focus)).toBe('2 combined');
  });
});

describe('describeRefFocus', () => {
  it('says the branch is not a checkout', () => {
    expect(
      describeRefFocus(refFocusForBranch({ branch: 'b', hasRemote: true })),
    ).toBe('b (remote)');
    expect(
      describeRefFocus(refFocusForBranch({ branch: 'b', hasLocalRef: true })),
    ).toBe('b (no worktree)');
    expect(
      describeRefFocus(
        refFocusForBranch({ branch: 'b', pr: { number: 4 } }),
      ),
    ).toBe('b (PR #4)');
  });
});

describe('compareRefToBase', () => {
  let r: ScratchRepo;
  beforeEach(() => {
    r = makeRepo({ withOrigin: true });
  });
  afterEach(() => r.cleanup());

  it('lists the commits and three-dot files of a ref with no checkout', async () => {
    commitOn(r.landing, 'feat/remote', 'main', { 'r.txt': 'remote\n' });
    git(r.landing, ['checkout', '-q', 'feat/remote']);
    fs.writeFileSync(path.join(r.landing, 'app.txt'), 'changed\n');
    git(r.landing, ['commit', '-qam', 'second']);
    git(r.landing, ['push', '-q', 'origin', 'feat/remote']);
    // main moves on after the fork: that work is NOT the branch's
    git(r.landing, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(r.landing, 'later.txt'), 'later\n');
    git(r.landing, ['add', '-A']);
    git(r.landing, ['commit', '-qm', 'main later']);
    git(r.landing, ['push', '-q', 'origin', 'main']);
    git(r.repo, ['fetch', '-q', 'origin']);

    const c = await compareRefToBase(
      r.repo,
      'origin/feat/remote',
      'origin/main',
    );
    expect(c.ahead).toBe(2);
    expect(c.tipBehind).toBe(1);
    expect(c.compareIsTip).toBe(false);
    expect(c.commitsAhead.map((x) => x.subject)).toEqual([
      'second',
      'feat/remote work',
    ]);
    // later.txt is on the base, not the branch — a two-dot diff against
    // the tip would list it as deleted
    expect(c.fullPrFiles).toEqual([
      { path: 'app.txt', status: 'M' },
      { path: 'r.txt', status: 'A' },
    ]);
  });

  it('reads a ref level with its base as empty', async () => {
    const c = await compareRefToBase(r.repo, 'main', 'origin/main');
    expect(c.ahead).toBe(0);
    expect(c.commitsAhead).toEqual([]);
    expect(c.fullPrFiles).toEqual([]);
    expect(c.compareIsTip).toBe(true);
  });
});

describe('ensureRefFocusFetched', () => {
  let r: ScratchRepo;
  beforeEach(() => {
    r = makeRepo({ withOrigin: true });
  });
  afterEach(() => r.cleanup());

  it('fetches a remote branch that is not here yet, without a local branch', async () => {
    commitOn(r.landing, 'feat/new', 'main', { 'n.txt': 'n\n' });
    git(r.landing, ['push', '-q', 'origin', 'feat/new']);
    const focus = refFocusForBranch({ branch: 'feat/new', hasRemote: true });
    expect(await refExists(r.repo, focus.ref)).toBe(false);

    expect(await ensureRefFocusFetched(r.repo, focus)).toBe(true);
    expect(await refExists(r.repo, 'origin/feat/new')).toBe(true);
    expect(await refExists(r.repo, 'refs/heads/feat/new')).toBe(false);
    // Already here: nothing to fetch
    expect(await ensureRefFocusFetched(r.repo, focus)).toBe(false);
  });

  it('fetches a PR head that has no branch ref (a fork)', async () => {
    commitOn(r.landing, 'fork-work', 'main', { 'f.txt': 'f\n' });
    // What GitHub publishes for every PR, fork or not
    git(r.landing, ['push', '-q', 'origin', 'fork-work:refs/pull/12/head']);
    const focus = refFocusForBranch({
      branch: 'fork-work',
      pr: { number: 12, baseRefName: 'main' },
    });

    await ensureRefFocusFetched(r.repo, focus);
    const base = await refFocusBase(r.repo, focus, 'main');
    expect(base).toBe('origin/main');
    const c = await compareRefToBase(r.repo, focus.ref, base);
    expect(c.fullPrFiles).toEqual([{ path: 'f.txt', status: 'A' }]);
  });

  it('refuses a local branch that is gone rather than fetching one', async () => {
    const focus = refFocusForBranch({ branch: 'gone', hasLocalRef: true });
    await expect(ensureRefFocusFetched(r.repo, focus)).rejects.toThrow(
      /no longer exists/,
    );
  });
});

describe('refFocusBase', () => {
  let r: ScratchRepo;
  beforeEach(() => {
    r = makeRepo({ withOrigin: true });
  });
  afterEach(() => r.cleanup());

  it("measures a PR branch against its PR's base, anything else the fallback", async () => {
    commitOn(r.landing, 'develop', 'main', { 'd.txt': 'd\n' });
    git(r.landing, ['push', '-q', 'origin', 'develop']);
    git(r.repo, ['fetch', '-q', 'origin']);
    expect(
      await refFocusBase(
        r.repo,
        refFocusForBranch({
          branch: 'x',
          hasRemote: true,
          pr: { number: 1, baseRefName: 'develop' },
        }),
        'main',
      ),
    ).toBe('origin/develop');
    expect(
      await refFocusBase(
        r.repo,
        refFocusForBranch({ branch: 'x', hasRemote: true }),
        'origin/main',
      ),
    ).toBe('origin/main');
  });
});

describe('listRecentCommits', () => {
  let r: ScratchRepo;
  beforeEach(() => {
    r = makeRepo();
  });
  afterEach(() => r.cleanup());

  // What Focus lists for the trunk: its own history, newest first, a page at a time
  it('returns the newest commits of a ref, newest first', async () => {
    for (const n of ['two', 'three']) {
      fs.writeFileSync(path.join(r.repo, `${n}.txt`), `${n}\n`);
      git(r.repo, ['add', '-A']);
      git(r.repo, ['commit', '-qm', n]);
    }
    const commits = await listRecentCommits(r.repo, 'main', 2);
    expect(commits.map((c) => c.subject)).toEqual(['three', 'two']);
    expect(commits[0].hash).toBe(git(r.repo, ['rev-parse', 'main']));
  });
});
