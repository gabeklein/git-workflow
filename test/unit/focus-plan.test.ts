import { describe, expect, it } from 'vitest';
import {
  checkoutLabel,
  planFocusRows,
  type FocusPlanInput,
} from '../../src/views/focusPlan';
import type { DiscoveredWorktree } from '../../src/discovery/scanner';
import type { BranchInfo } from '../../src/git/branches';

/**
 * Ordering and grouping for the unified Focus panel. The rule under test
 * throughout: a worktree is an activity status of a branch, so a branch
 * appears exactly once — as a checkout if it has one, otherwise as a
 * branch row.
 */
const wt = (
  branch: string,
  opts: Partial<DiscoveredWorktree> = {},
): DiscoveredWorktree =>
  ({
    path: `/repo/.worktrees/${branch.replace(/\//g, '-')}`,
    branch,
    detached: false,
    ...opts,
  }) as DiscoveredWorktree;

const br = (
  name: string,
  committerDate: number,
  opts: Partial<BranchInfo> = {},
): BranchInfo => ({
  name,
  hasLocalRef: true,
  hasRemote: false,
  committerDate,
  relativeDate: '',
  ...opts,
});

const plan = (input: Partial<FocusPlanInput>) =>
  planFocusRows({ worktrees: [], branches: [], ...input });

describe('planFocusRows', () => {
  it('puts the root checkout first regardless of recency', () => {
    const result = plan({
      worktrees: [
        wt('feat/new'),
        wt('main', { path: '/repo', isRootCheckout: true }),
      ],
      branches: [br('feat/new', 200), br('main', 100)],
    });
    expect(result.checkouts.map((c) => c.branch)).toEqual(['main', 'feat/new']);
  });

  it('orders the rest by tip recency, newest first', () => {
    const result = plan({
      worktrees: [wt('feat/old'), wt('feat/new'), wt('feat/mid')],
      branches: [br('feat/new', 300), br('feat/mid', 200), br('feat/old', 100)],
    });
    expect(result.checkouts.map((c) => c.branch)).toEqual([
      'feat/new',
      'feat/mid',
      'feat/old',
    ]);
  });

  it('sinks detached checkouts below named ones instead of dating them as ancient', () => {
    const result = plan({
      worktrees: [
        wt('abc1234', { detached: true }),
        wt('feat/a'),
        wt('main', { path: '/repo', isRootCheckout: true }),
      ],
      branches: [br('feat/a', 100), br('main', 50)],
    });
    expect(result.checkouts.map((c) => c.branch)).toEqual([
      'main',
      'feat/a',
      'abc1234',
    ]);
  });

  // The core of the merge: no branch is ever in two places at once.
  it('a branch with a checkout never also appears as a branch row', () => {
    const result = plan({
      worktrees: [wt('feat/a')],
      branches: [br('feat/a', 200), br('feat/b', 100)],
    });
    expect(result.checkouts.map((c) => c.branch)).toEqual(['feat/a']);
    expect(result.branches.map((b) => b.name)).toEqual(['feat/b']);
  });

  it('splits local-only from remote-only', () => {
    const result = plan({
      branches: [
        br('feat/local', 300),
        br('feat/remote', 200, { hasLocalRef: false, hasRemote: true }),
        br('feat/both', 100, { hasRemote: true }),
      ],
    });
    expect(result.branches.map((b) => b.name)).toEqual([
      'feat/local',
      'feat/both',
    ]);
    expect(result.remote.map((b) => b.name)).toEqual(['feat/remote']);
  });

  it('keeps the integration branch out of the list entirely', () => {
    const result = plan({
      worktrees: [wt('integration/main', { path: '/repo/working' })],
      branches: [br('integration/main', 300), br('feat/a', 200)],
      integrationBranch: 'integration/main',
      integrationPath: '/repo/working',
    });
    expect(result.checkouts).toEqual([]);
    expect(result.branches.map((b) => b.name)).toEqual(['feat/a']);
  });

  it('a detached checkout does not claim any branch row', () => {
    const result = plan({
      worktrees: [wt('abc1234', { detached: true })],
      branches: [br('abc1234', 100)],
    });
    expect(result.branches.map((b) => b.name)).toEqual(['abc1234']);
  });

  it('floats branches with an open PR above the remote cap', () => {
    const branches = Array.from({ length: 5 }, (_, i) =>
      br(`remote/new-${i}`, 500 - i, { hasLocalRef: false, hasRemote: true }),
    );
    branches.push(
      br('remote/old-pr', 1, { hasLocalRef: false, hasRemote: true }),
    );
    const result = plan({
      branches,
      prHeads: new Set(['remote/old-pr']),
      limit: 2,
    });
    expect(result.remote.map((b) => b.name)).toContain('remote/old-pr');
    expect(result.remote).toHaveLength(2);
  });

  it('reports what the cap hid rather than dropping it silently', () => {
    const result = plan({
      branches: Array.from({ length: 7 }, (_, i) => br(`feat/${i}`, 100 - i)),
      limit: 3,
    });
    expect(result.branches).toHaveLength(3);
    expect(result.hiddenBranches).toBe(4);
  });
});

describe('checkoutLabel', () => {
  it('names a detached checkout by sha', () => {
    expect(checkoutLabel(wt('abc1234', { detached: true }), 'abc1234')).toBe(
      'Detached (abc1234)',
    );
  });

  it('uses the branch otherwise', () => {
    expect(checkoutLabel(wt('feat/a'))).toBe('feat/a');
  });
});
