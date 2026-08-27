import { describe, expect, it } from 'vitest';
import {
  checkoutLabel,
  orderLaneRows,
  planLaneRows,
  type LanesPlanInput,
} from '../../src/views/lanesPlan';
import type { DiscoveredWorktree } from '../../src/discovery/scanner';
import type { BranchInfo } from '../../src/git/branches';

/**
 * Ordering and grouping for the Lanes panel. The rule under test
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

const plan = (input: Partial<LanesPlanInput>) =>
  planLaneRows({ worktrees: [], branches: [], ...input });

describe('planLaneRows', () => {
  it('puts the root checkout first regardless of recency', () => {
    const result = plan({
      worktrees: [
        wt('feat/new'),
        wt('main', { path: '/repo', isRootCheckout: true }),
      ],
      branches: [br('feat/new', 200), br('main', 100)],
    });
    expect(result.working.map((c) => c.branch)).toEqual(['main', 'feat/new']);
  });

  it('orders the rest by tip recency, newest first', () => {
    const result = plan({
      worktrees: [wt('feat/old'), wt('feat/new'), wt('feat/mid')],
      branches: [br('feat/new', 300), br('feat/mid', 200), br('feat/old', 100)],
    });
    expect(result.working.map((c) => c.branch)).toEqual([
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
    expect(result.working.map((c) => c.branch)).toEqual([
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
    expect(result.working.map((c) => c.branch)).toEqual(['feat/a']);
    expect(result.local.map((b) => b.name)).toEqual(['feat/b']);
  });

  it('splits local-only from remote-only', () => {
    const result = plan({
      branches: [
        br('feat/local', 300),
        br('feat/remote', 200, { hasLocalRef: false, hasRemote: true }),
        br('feat/both', 100, { hasRemote: true }),
      ],
    });
    expect(result.local.map((b) => b.name)).toEqual([
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
    expect(result.working).toEqual([]);
    expect(result.local.map((b) => b.name)).toEqual(['feat/a']);
  });

  it('a detached checkout does not claim any branch row', () => {
    const result = plan({
      worktrees: [wt('abc1234', { detached: true })],
      branches: [br('abc1234', 100)],
    });
    expect(result.local.map((b) => b.name)).toEqual(['abc1234']);
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
    expect(result.local).toHaveLength(3);
    expect(result.hiddenLocal).toBe(4);
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

/**
 * Lanes merge in the order they were included, and that order decides
 * which lane wins a conflict. Rendering it sorted showed an order the
 * rebuild does not use — on precisely the question where order matters.
 */
describe('orderLaneRows', () => {
  it('keeps the stored order, not alphabetical', () => {
    expect(orderLaneRows(['zebra', 'alpha'], ['zebra', 'alpha'])).toEqual([
      'zebra',
      'alpha',
    ]);
  });

  it('sorts anything the order has not placed yet', () => {
    expect(orderLaneRows(['zebra'], ['zebra', 'delta', 'beta'])).toEqual([
      'zebra',
      'beta',
      'delta',
    ]);
  });

  it('drops an ordered lane that no longer exists', () => {
    // A lane deleted out from under the order must not resurrect as a row
    expect(orderLaneRows(['gone', 'a'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('holds an unchecked lane in place — the point of the split', () => {
    // Checking or unchecking touches membership, never this list, so the
    // row does not move under the cursor.
    const order = ['a', 'b', 'c'];
    expect(orderLaneRows(order, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('never lists an applied lane twice', () => {
    expect(orderLaneRows(['a', 'b'], ['b', 'c', 'a'])).toEqual(['a', 'b', 'c']);
  });

  it('dedupes the remainder', () => {
    expect(orderLaneRows([], ['x', 'x', 'y'])).toEqual(['x', 'y']);
  });

  it('handles nothing applied', () => {
    expect(orderLaneRows([], ['c', 'a'])).toEqual(['a', 'c']);
  });
});

/**
 * The ladder. Each rung is defined by falling through the one above, so
 * the properties worth pinning are that nothing appears twice and that
 * Landed — decided FIRST, shown LAST — claims a branch even when it still
 * has a checkout. Miss that and the group whose entire purpose is cleanup
 * never sees the thing most worth cleaning.
 */
describe('planLaneRows — the ladder', () => {
  it('claims a landed branch even though it still has a checkout', () => {
    const result = plan({
      worktrees: [wt('feat/done'), wt('feat/live')],
      branches: [br('feat/done', 2), br('feat/live', 1)],
      landed: new Set(['feat/done']),
    });
    expect(result.landed.map((l) => l.branch)).toEqual(['feat/done']);
    // ...and carries the checkout, so the row can offer to remove the folder
    expect(result.landed[0]?.worktree?.branch).toBe('feat/done');
    expect(result.working.map((w) => w.branch)).toEqual(['feat/live']);
  });

  it('lists a landed branch with no checkout as a bare lane', () => {
    const result = plan({
      branches: [br('feat/gone', 1)],
      landed: new Set(['feat/gone']),
    });
    expect(result.landed).toEqual([{ branch: 'feat/gone' }]);
    expect(result.local).toEqual([]);
  });

  it('never lists a branch in two groups', () => {
    const result = plan({
      worktrees: [wt('feat/a')],
      branches: [
        br('feat/a', 3),
        br('feat/b', 2),
        br('feat/c', 1, { hasLocalRef: false, hasRemote: true }),
        br('feat/done', 4),
      ],
      landed: new Set(['feat/done']),
    });
    const everywhere = [
      ...result.working.map((w) => w.branch),
      ...result.local.map((b) => b.name),
      ...result.remote.map((b) => b.name),
      ...result.landed.map((l) => l.branch),
    ];
    expect(new Set(everywhere).size).toBe(everywhere.length);
    expect(everywhere.sort()).toEqual([
      'feat/a',
      'feat/b',
      'feat/c',
      'feat/done',
    ]);
  });

  it('keeps a branch that is both local and remote in Local only', () => {
    // Sync state is a badge on the Local row, not a second row in Remote
    const result = plan({
      branches: [br('feat/pushed', 1, { hasRemote: true })],
    });
    expect(result.local.map((b) => b.name)).toEqual(['feat/pushed']);
    expect(result.remote).toEqual([]);
  });

  it('cannot land a detached checkout — it has no branch to land', () => {
    const result = plan({
      worktrees: [wt('abc1234', { detached: true })],
      landed: new Set(['abc1234']),
    });
    expect(result.landed).toEqual([]);
    expect(result.working).toHaveLength(1);
  });

  it('leaves every group empty-but-present when nothing has landed', () => {
    const result = plan({
      worktrees: [wt('feat/a')],
      branches: [br('feat/a', 1)],
    });
    expect(result.landed).toEqual([]);
  });
});
