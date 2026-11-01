/**
 * The Lanes panel: Working, Local and Remote as one tree.
 * A worktree is an activity status of a branch, so the invariant under
 * test throughout is that a branch appears exactly once — under Working
 * if it has a checkout, otherwise under Local.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getApi,
  git,
  gitOk,
  landing,
  poll,
  repo,
  run,
  type TestApi,
} from './helpers';

describe('focus panel', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  const labels = async (group?: 'working' | 'local' | 'remote' | 'landed') =>
    (await api.focusRows(group)).map((r) => r.label);

  it('leads with the preview row, then Working and Local', async () => {
    await poll('lanes panel renders its rows', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await api.focusRows()).length >= 3;
    });
    const rows = await api.focusRows();
    // The preview is a ROW, not a group: there is exactly one, so a
    // heading over it could never hold a second entry.
    assert.equal(rows[0]?.kind, 'preview', 'the preview leads the panel');
    assert.deepEqual(
      rows.filter((r) => r.kind === 'group').map((r) => r.group).slice(0, 2),
      ['working', 'local'],
    );
    assert.ok(
      rows.slice(1).every((r) => r.kind === 'group'),
      'below the preview the panel is groups only — every row is in a section',
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

  it('keeps the preview branch out of every group', async () => {
    const groups = {
      working: await labels('working'),
      local: await labels('local'),
      remote: await labels('remote'),
    };
    const stragglers = Object.entries(groups).flatMap(([group, labels]) =>
      labels.filter((l) => l.startsWith('preview/')).map((l) => `${group}/${l}`),
    );
    assert.deepEqual(
      stragglers,
      [],
      'the preview is the leading row, never a row in a group',
    );
  });
});

/**
 * A branch with no checkout is explored IN Focus, read-only, from its ref
 * — fetched first when it is not here yet. Runs after the Lanes checks
 * that assert there is no Remote group, and removes its branch again so
 * nothing later inherits one.
 */
describe('focusing a branch with no checkout', () => {
  let api: TestApi;
  let before_: string | undefined;
  const branch = 'feat/remote-only';
  before(async () => {
    api = await getApi();
    before_ = api.selectedPath();
    // Published from the "GitHub side" and NOT fetched here: focusing it
    // has to fetch it.
    git(landing, ['fetch', '-q', 'origin']);
    git(landing, ['checkout', '-q', '-b', branch, 'origin/main']);
    fs.writeFileSync(path.join(landing, 'remote.txt'), 'only on the remote\n');
    git(landing, ['add', 'remote.txt']);
    git(landing, ['commit', '-qm', 'remote only work']);
    git(landing, ['push', '-q', 'origin', branch]);
    git(landing, ['checkout', '-q', 'main']);
  });
  after(async () => {
    if (gitOk(landing, ['ls-remote', '--exit-code', 'origin', branch]))
      git(landing, ['push', '-q', 'origin', '--delete', branch]);
    git(repo, ['fetch', '-q', '--prune', 'origin']);
    if (before_) await run('worktreeCompare.focusWorktree', before_);
  });

  it('fetches the ref and shows its commits and Full Diff, read-only', async () => {
    assert.ok(
      !gitOk(repo, ['rev-parse', '--verify', `origin/${branch}`]),
      'the branch is not fetched yet',
    );
    await run('worktreeCompare.focusBranch', {
      branch,
      hasLocalRef: false,
      hasRemote: true,
    });
    assert.equal(api.focusedRef()?.ref, `origin/${branch}`);
    assert.equal(
      api.selectedPath(),
      undefined,
      'no checkout is selected while a ref is focused',
    );
    assert.ok(
      !gitOk(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]),
      'focusing creates no local branch',
    );

    await poll('Focus renders the ref', 30000, async () =>
      (await api.changesRows()).some((r) => r.label.startsWith('Commits')),
    );
    const labels = (await api.changesRows()).map((r) => r.label);
    // No working tree: nothing staged, unstaged, or to browse
    assert.deepEqual(labels, ['Commits · 1', 'Full Diff']);

    const commits = await api.changesChildren('Commits');
    assert.deepEqual(
      commits.map((c) => c.label),
      ['remote only work'],
    );
    const files = await api.changesChildren('Full Diff');
    assert.deepEqual(
      files.map((f) => [f.label, f.contextValue]),
      [['remote.txt', 'refFile']],
      'files diff ref ↔ ref, with no write actions',
    );
  });

  it('lists the fetched branch under Remote', async () => {
    await poll('the branch appears under Remote', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await api.focusRows('remote')).some((r) => r.label === branch);
    });
  });

  it('falls back to a checkout when the ref disappears', async () => {
    git(landing, ['push', '-q', 'origin', '--delete', branch]);
    git(repo, ['fetch', '-q', '--prune', 'origin']);
    await poll('focus leaves the deleted ref', 30000, async () => {
      await run('worktreeCompare.refresh');
      return api.focusedRef() === undefined && Boolean(api.selectedPath());
    });
  });
});
