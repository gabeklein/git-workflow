/**
 * The unified Focus panel: Worktrees, Branches and Remote as one tree.
 * A worktree is an activity status of a branch, so the invariant under
 * test throughout is that a branch appears exactly once — under Worktrees
 * if it has a checkout, otherwise under Branches.
 */
import * as assert from 'node:assert/strict';
import { getApi, git, poll, repo, run, type TestApi } from './helpers';

describe('focus panel', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  const labels = async (group?: 'worktrees' | 'branches' | 'remote') =>
    (await api.focusRows(group)).map((r) => r.label);

  it('offers exactly the three groups, in order', async () => {
    await poll('focus panel renders its groups', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await api.focusRows()).length >= 3;
    });
    const rows = await api.focusRows();
    assert.deepEqual(
      rows.filter((r) => r.kind === 'group').map((r) => r.group),
      ['worktrees', 'branches', 'remote'],
    );
    assert.ok(
      rows.every((r) => r.kind === 'group'),
      'the root is groups only — every row lives in a section',
    );
  });

  it('lists the checkouts under Worktrees', async () => {
    await poll('worktrees group is populated', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await api.focusRows('worktrees')).some(
        (r) => r.kind === 'worktreeList',
      );
    });
    const discovered = api.worktrees().map((w) => w.branch);
    for (const label of await labels('worktrees')) {
      assert.ok(
        discovered.includes(label),
        `${label} under Worktrees is a discovered checkout`,
      );
    }
  });

  it('a branch with a checkout is not repeated under Branches', async () => {
    const checkouts = await labels('worktrees');
    const branches = await labels('branches');
    for (const c of checkouts) {
      assert.ok(
        !branches.includes(c),
        `${c} has a checkout and must not also be a branch row`,
      );
    }
  });

  it('a branch moves between the groups as its checkout comes and goes', async () => {
    git(repo, ['branch', 'feat/focus-demo', 'main']);
    await poll('new branch shows under Branches', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await labels('branches')).includes('feat/focus-demo');
    });
    assert.ok(
      !(await labels('worktrees')).includes('feat/focus-demo'),
      'it is not under Worktrees while it has no checkout',
    );

    git(repo, [
      'worktree', 'add', '-q', '.worktrees/focus-demo', 'feat/focus-demo',
    ]);
    await poll('it moves under Worktrees', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await labels('worktrees')).includes('feat/focus-demo');
    });
    assert.ok(
      !(await labels('branches')).includes('feat/focus-demo'),
      'and it leaves Branches — never in both',
    );

    git(repo, ['worktree', 'remove', '--force', '.worktrees/focus-demo']);
    await poll('it returns to Branches when the checkout goes', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await labels('branches')).includes('feat/focus-demo');
    });
    git(repo, ['branch', '-D', 'feat/focus-demo']);
    await poll('cleanup settles', 30000, async () => {
      await run('worktreeCompare.refresh');
      return !(await labels('branches')).includes('feat/focus-demo');
    });
  });

  it('keeps the integration branch out of every group', async () => {
    const everything = [
      ...(await labels('worktrees')),
      ...(await labels('branches')),
      ...(await labels('remote')),
    ];
    assert.ok(
      !everything.some((l) => l.startsWith('integration/')),
      'the integration branch is the panel subject, not a row',
    );
  });
});
