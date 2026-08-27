/**
 * The Lanes panel: Working, Local and Remote as one tree.
 * A worktree is an activity status of a branch, so the invariant under
 * test throughout is that a branch appears exactly once — under Working
 * if it has a checkout, otherwise under Local.
 */
import * as assert from 'node:assert/strict';
import { getApi, git, poll, repo, run, type TestApi } from './helpers';

describe('focus panel', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  const labels = async (group?: 'working' | 'local' | 'remote' | 'landed') =>
    (await api.focusRows(group)).map((r) => r.label);

  it('offers Preview, Working and Local, in order, and nothing loose', async () => {
    await poll('lanes panel renders its groups', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await api.focusRows()).length >= 3;
    });
    const rows = await api.focusRows();
    const groups = rows.filter((r) => r.kind === 'group').map((r) => r.group);
    // Preview leads: it is what the lanes below are combined INTO.
    assert.deepEqual(groups.slice(0, 3), ['preview', 'working', 'local']);
    assert.ok(
      rows.every((r) => r.kind === 'group'),
      'the root is groups only — every row lives in a section',
    );
  });

  // Every branch in the fixture has a local ref, so nothing lives only on
  // the remote and the group would be a heading over nothing.
  it('hides Remote when nothing lives only on the remote', async () => {
    const groups = (await api.focusRows())
      .filter((r) => r.kind === 'group')
      .map((r) => r.group);
    assert.ok(
      !groups.includes('remote'),
      'no remote-only branches, so no Remote group',
    );
  });

  it('lists the checkouts under Working', async () => {
    await poll('worktrees group is populated', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await api.focusRows('working')).some(
        (r) => r.kind === 'worktreeList',
      );
    });
    const discovered = api.worktrees().map((w) => w.branch);
    for (const label of await labels('working')) {
      assert.ok(
        discovered.includes(label),
        `${label} under Working is a discovered checkout`,
      );
    }
  });

  // Selection is drawn from contextValue (…Active) plus a FileDecoration
  // tint, so if this passes and the row still looks unselected, the flag is
  // fine and the tint is being lost at paint time.
  it('marks the focused checkout as active', async () => {
    const target = api.worktrees().find((w) => w.path.includes('feat-a'));
    assert.ok(target, 'fixture has a feat/a checkout');
    await run('worktreeCompare.focusWorktree', target.path);
    await poll('the focused row reports itself active', 30000, async () => {
      await run('worktreeCompare.refresh');
      const row = (await api.focusRows('working')).find(
        (r) => r.label === target.branch,
      );
      return Boolean(row?.contextValue?.startsWith('worktreeListItemActive'));
    });
    const others = (await api.focusRows('working')).filter(
      (r) => r.kind === 'worktreeList' && r.label !== target.branch,
    );
    assert.ok(
      others.every(
        (r) => !r.contextValue?.startsWith('worktreeListItemActive'),
      ),
      'exactly one row is active at a time',
    );
  });

  it('a branch with a checkout is not repeated under Local', async () => {
    const checkouts = await labels('working');
    const branches = await labels('local');
    for (const c of checkouts) {
      assert.ok(
        !branches.includes(c),
        `${c} has a checkout and must not also be a branch row`,
      );
    }
  });

  it('a branch moves between the groups as its checkout comes and goes', async () => {
    git(repo, ['branch', 'feat/focus-demo', 'main']);
    await poll('new branch shows under Local', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await labels('local')).includes('feat/focus-demo');
    });
    assert.ok(
      !(await labels('working')).includes('feat/focus-demo'),
      'it is not under Working while it has no checkout',
    );

    git(repo, [
      'worktree', 'add', '-q', '.worktrees/focus-demo', 'feat/focus-demo',
    ]);
    await poll('it moves under Working', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await labels('working')).includes('feat/focus-demo');
    });
    assert.ok(
      !(await labels('local')).includes('feat/focus-demo'),
      'and it leaves Local — never in both',
    );

    git(repo, ['worktree', 'remove', '--force', '.worktrees/focus-demo']);
    await poll('it returns to Local when the checkout goes', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await labels('local')).includes('feat/focus-demo');
    });
    git(repo, ['branch', '-D', 'feat/focus-demo']);
    await poll('cleanup settles', 30000, async () => {
      await run('worktreeCompare.refresh');
      return !(await labels('local')).includes('feat/focus-demo');
    });
  });

  // Membership is carried by the row decoration badge, so spending a word
  // of description on it too would be saying the same thing twice.
  it('leaves preview membership and local-only to the badge', async () => {
    const rows = await api.focusRows('working');
    assert.ok(rows.length > 0, 'there are checkouts to inspect');
    for (const row of rows) {
      assert.ok(
        !row.description.includes('applied'),
        `${row.label} should not spell out 'applied': ${row.description}`,
      );
      assert.ok(
        !/(^|· )local( |$)/.test(row.description),
        `${row.label} should not spell out 'local': ${row.description}`,
      );
    }
  });

  it('keeps the integration branch out of every group', async () => {
    const everything = [
      ...(await labels('working')),
      ...(await labels('local')),
      ...(await labels('remote')),
    ];
    assert.ok(
      !everything.some((l) => l.startsWith('integration/')),
      'the integration branch is the panel subject, not a row',
    );
  });
});
