import { afterEach, describe, expect, it } from 'vitest';
import { setConfig, setWindowFocused } from './vscode-stub';
import { isRateLimitRefusal } from '../../src/github/gh';
import { PullRequestIndex } from '../../src/github/prIndex';
import { PullRequestCache } from '../../src/views/pullRequestCache';
import type { DiscoveredWorktree } from '../../src/git/discovery';

/**
 * The GitHub API budget is 5000 requests an hour, shared with whatever the
 * user runs themselves — so what is under test here is not correctness of
 * the PR badges but how MANY times the extension is willing to ask. The
 * old shape asked per branch, twice, on every discovery load; these tests
 * pin the shape that replaced it, because nothing about the UI looks
 * different when it regresses.
 */

const silent = { appendLine: () => undefined };

function row(n: number, head: string, state = 'OPEN') {
  return {
    number: n,
    title: `PR ${n}`,
    state,
    url: `https://github.com/o/r/pull/${n}`,
    headRefName: head,
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  };
}

/** A gh runner that records every query it was asked to run. */
function recorder(answers: (args: string[]) => unknown) {
  const calls: string[][] = [];
  return {
    calls,
    ghJson: async <T>(_cwd: string, args: string[]): Promise<T | undefined> => {
      calls.push(args);
      return answers(args) as T;
    },
  };
}

const present = async () => true;

function worktree(
  path: string,
  branch: string,
  publishState: 'pushed' | 'local' = 'pushed',
): DiscoveredWorktree {
  return {
    path,
    name: path.split('/').pop() ?? path,
    branch,
    detached: false,
    publishState,
  };
}

afterEach(() => {
  setConfig();
  setWindowFocused(true);
});

describe('PullRequestIndex', () => {
  it('answers every branch with ONE query, not one query per branch', async () => {
    const gh = recorder(() => [row(1, 'feat-a'), row(2, 'feat-b')]);
    const index = new PullRequestIndex(silent, { ghJson: gh.ghJson, ghPresent: present });

    await index.ensureOpen('/repo');

    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]).toContain('--state');
    expect(gh.calls[0]).toContain('open');
    // No --head: the query is repo-wide, which is the whole saving
    expect(gh.calls[0]).not.toContain('--head');
    expect(index.get('feat-a')?.number).toBe(1);
    expect(index.get('feat-b')?.number).toBe(2);
  });

  it('holds the answer for the refresh window instead of re-asking', async () => {
    setConfig({ githubPrRefreshMs: 120_000 });
    let now = 1_000_000;
    const gh = recorder(() => [row(1, 'feat-a')]);
    const index = new PullRequestIndex(silent, {
      ghJson: gh.ghJson,
      ghPresent: present,
      now: () => now,
    });

    await index.ensureOpen('/repo');
    // The burst of refreshes a single file event produces
    for (let i = 0; i < 20; i += 1) await index.ensureOpen('/repo');
    expect(gh.calls).toHaveLength(1);

    now += 119_000;
    await index.ensureOpen('/repo');
    expect(gh.calls).toHaveLength(1);

    now += 2_000;
    await index.ensureOpen('/repo');
    expect(gh.calls).toHaveLength(2);
  });

  it('force overrides the window — an explicit refresh always asks', async () => {
    const gh = recorder(() => [row(1, 'feat-a')]);
    const index = new PullRequestIndex(silent, { ghJson: gh.ghJson, ghPresent: present });

    await index.ensureOpen('/repo');
    await index.ensureOpen('/repo');
    await index.ensureOpen('/repo', true);

    expect(gh.calls).toHaveLength(2);
  });

  it('concurrent callers share one in-flight query', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[][] = [];
    const index = new PullRequestIndex(silent, {
      ghPresent: present,
      ghJson: async <T>(_c: string, args: string[]) => {
        calls.push(args);
        await gate;
        return [row(1, 'feat-a')] as unknown as T;
      },
    });

    const both = Promise.all([index.ensureOpen('/repo'), index.ensureOpen('/repo')]);
    release?.();
    await both;

    expect(calls).toHaveLength(1);
  });

  it('does not ask again while the window is unfocused, but answers once', async () => {
    let now = 1_000_000;
    const gh = recorder(() => [row(1, 'feat-a')]);
    const index = new PullRequestIndex(silent, {
      ghJson: gh.ghJson,
      ghPresent: present,
      now: () => now,
    });

    // Never asked: a background window still gets its first answer
    setWindowFocused(false);
    await index.ensureOpen('/repo');
    expect(gh.calls).toHaveLength(1);

    now += 10 * 60_000;
    await index.ensureOpen('/repo');
    expect(gh.calls).toHaveLength(1);

    setWindowFocused(true);
    await index.ensureOpen('/repo');
    expect(gh.calls).toHaveLength(2);
  });

  it('keeps the last answer when a query fails, and closes the window anyway', async () => {
    let now = 1_000_000;
    let fail = false;
    const gh = recorder(() => (fail ? undefined : [row(1, 'feat-a')]));
    const index = new PullRequestIndex(silent, {
      ghJson: gh.ghJson,
      ghPresent: present,
      now: () => now,
    });

    await index.ensureOpen('/repo');
    fail = true;
    now += 200_000;
    await index.ensureOpen('/repo');

    // The badge survives the failed refresh…
    expect(index.get('feat-a')?.number).toBe(1);
    // …and the failure is not retried until the window lapses again
    now += 1_000;
    await index.ensureOpen('/repo');
    expect(gh.calls).toHaveLength(2);
  });

  it('gives closed/merged PRs their own, longer window', async () => {
    setConfig({ githubPrRefreshMs: 60_000 });
    let now = 1_000_000;
    const gh = recorder((args) =>
      args.includes('closed') ? [row(9, 'landed', 'MERGED')] : [],
    );
    const index = new PullRequestIndex(silent, {
      ghJson: gh.ghJson,
      ghPresent: present,
      now: () => now,
    });

    await index.ensureClosed('/repo');
    expect(index.get('landed')?.state).toBe('merged');

    now += 5 * 60_000; // well past the open window
    await index.ensureClosed('/repo');
    expect(gh.calls).toHaveLength(1);

    now += 11 * 60_000; // past the 15-minute floor
    await index.ensureClosed('/repo');
    expect(gh.calls).toHaveLength(2);
  });

  it('asks nothing when gh is not installed', async () => {
    const gh = recorder(() => []);
    const index = new PullRequestIndex(silent, {
      ghJson: gh.ghJson,
      ghPresent: async () => false,
    });
    await index.ensureOpen('/repo');
    expect(gh.calls).toHaveLength(0);
  });
});

describe('PullRequestCache over the index', () => {
  it('costs one query for many checkouts, and none for a second refresh', async () => {
    const gh = recorder(() => [row(1, 'feat-a'), row(2, 'feat-b')]);
    const index = new PullRequestIndex(silent, { ghJson: gh.ghJson, ghPresent: present });
    const cache = new PullRequestCache(silent, () => undefined, index);
    const worktrees = [
      worktree('/w/a', 'feat-a'),
      worktree('/w/b', 'feat-b'),
      worktree('/w/c', 'feat-c'),
    ];

    await cache.refresh(worktrees, '/repo');
    // open list, plus ONE closed list because feat-c is pushed with no open PR
    expect(gh.calls).toHaveLength(2);
    expect(cache.get('/w/a', 'feat-a')?.number).toBe(1);

    await cache.refresh(worktrees, '/repo');
    expect(gh.calls).toHaveLength(2);
  });

  it('never asks about a branch that has never been pushed', async () => {
    const gh = recorder(() => [row(1, 'feat-a')]);
    const index = new PullRequestIndex(silent, { ghJson: gh.ghJson, ghPresent: present });
    const cache = new PullRequestCache(silent, () => undefined, index);

    await cache.refresh(
      [worktree('/w/a', 'feat-a'), worktree('/w/z', 'scratch', 'local')],
      '/repo',
    );

    // Only the open list: a local-only branch cannot have a PR to find
    expect(gh.calls).toHaveLength(1);
    expect(cache.get('/w/z', 'scratch')).toBeUndefined();
  });
});

describe('rate-limit refusals', () => {
  it('recognises what gh says when the budget is spent', () => {
    expect(
      isRateLimitRefusal('HTTP 403: API rate limit exceeded for user ID 1'),
    ).toBe(true);
    expect(
      isRateLimitRefusal('You have exceeded a secondary rate limit'),
    ).toBe(true);
    expect(isRateLimitRefusal('could not resolve to a Repository')).toBe(false);
  });
});
