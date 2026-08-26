/**
 * The unified Focus panel: checkouts on top as themselves, branches and
 * remotes below as things that could become one. A branch is never in two
 * places at once — that invariant IS the merge of the two old panels.
 */
import * as assert from 'node:assert/strict';
import { getApi, git, poll, repo, run, type TestApi } from './helpers';

describe('focus panel', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  const labels = async (group?: 'branches' | 'remote') =>
    (await api.focusRows(group)).map((r) => r.label);

  it('renders checkouts above the groups, never interleaved', async () => {
    await poll('focus panel renders the checkouts', 30000, async () => {
      await run('worktreeCompare.refresh');
      const rows = await api.focusRows();
      return rows.some((r) => r.kind === 'worktreeList');
    });
    const rows = await api.focusRows();
    const firstGroup = rows.findIndex((r) => r.kind === 'group');
    const lastCheckout = rows.map((r) => r.kind).lastIndexOf('worktreeList');
    assert.ok(firstGroup > lastCheckout, 'groups sit below the checkouts');
    // Root-first is pinned in test/unit/focus-plan.test.ts, where the input
    // is controlled: discovery omits a CLEAN root checkout entirely
    // (includeRootCheckout=dirty), so the fixture has no root row to order.
    assert.ok(
      rows.every((r) => r.kind !== 'worktreeList' || r.label !== ''),
      'every checkout row is labelled',
    );
  });

  it('offers exactly the Branches and Remote groups', async () => {
    const groups = (await api.focusRows())
      .filter((r) => r.kind === 'group')
      .map((r) => r.group);
    assert.deepEqual(groups, ['branches', 'remote']);
  });

  it('a branch with a checkout is not repeated under Branches', async () => {
    const checkouts = (await api.focusRows())
      .filter((r) => r.kind === 'worktreeList')
      .map((r) => r.label);
    const branchGroup = await labels('branches');
    for (const c of checkouts) {
      assert.ok(
        !branchGroup.includes(c),
        `${c} has a checkout and must not also be a branch row`,
      );
    }
  });

  it('a branch without a checkout appears under Branches, and moves up once it gets one', async () => {
    git(repo, ['branch', 'feat/focus-demo', 'main']);
    await poll('new branch shows under Branches', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await labels('branches')).includes('feat/focus-demo');
    });
    assert.ok(
      !(await labels()).includes('feat/focus-demo'),
      'it is not a top-level row while it has no checkout',
    );

    git(repo, [
      'worktree', 'add', '-q', '.worktrees/focus-demo', 'feat/focus-demo',
    ]);
    await poll('it becomes a checkout row', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await labels()).includes('feat/focus-demo');
    });
    assert.ok(
      !(await labels('branches')).includes('feat/focus-demo'),
      'and it leaves the Branches group — never in both',
    );

    git(repo, ['worktree', 'remove', '--force', '.worktrees/focus-demo']);
    git(repo, ['branch', '-D', 'feat/focus-demo']);
    await poll('cleanup settles', 30000, async () => {
      await run('worktreeCompare.refresh');
      return !(await labels()).includes('feat/focus-demo');
    });
  });

  it('keeps the integration branch out of the list entirely', async () => {
    const everything = [
      ...(await labels()),
      ...(await labels('branches')),
      ...(await labels('remote')),
    ];
    assert.ok(
      !everything.some((l) => l.startsWith('integration/')),
      'the integration branch is the panel subject, not a row',
    );
  });
});
