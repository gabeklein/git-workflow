/**
 * The unified Focus panel: one FLAT list. Checkouts on top as themselves,
 * then a separator per section rather than a collapsible group — a branch
 * with a checkout and a branch without one are peers, so nesting the second
 * kind under a container would misstate the model.
 *
 * The invariant under test throughout: a branch appears exactly once.
 */
import * as assert from 'node:assert/strict';
import { getApi, git, poll, repo, run, type TestApi } from './helpers';

describe('focus panel', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  const rows = () => api.focusRows();
  const labels = async () => (await rows()).map((r) => r.label);
  const sectionAt = async (section: 'branches' | 'remote') => {
    const all = await rows();
    const start = all.findIndex(
      (r) => r.kind === 'separator' && r.section === section,
    );
    if (start < 0) {
      return [];
    }
    const after = all.slice(start + 1);
    const end = after.findIndex((r) => r.kind === 'separator');
    return (end < 0 ? after : after.slice(0, end)).map((r) => r.label);
  };

  it('renders checkouts above the separators, never interleaved', async () => {
    await poll('focus panel renders the checkouts', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await rows()).some((r) => r.kind === 'worktreeList');
    });
    const all = await rows();
    const firstSeparator = all.findIndex((r) => r.kind === 'separator');
    const lastCheckout = all.map((r) => r.kind).lastIndexOf('worktreeList');
    assert.ok(firstSeparator > lastCheckout, 'separators sit below checkouts');
    // Root-first is pinned in test/unit/focus-plan.test.ts, where the input
    // is controlled: discovery omits a CLEAN root checkout entirely
    // (includeRootCheckout=dirty), so the fixture has no root row to order.
  });

  it('uses separators, not groups — every row is top level', async () => {
    const all = await rows();
    const sections = all
      .filter((r) => r.kind === 'separator')
      .map((r) => r.section);
    assert.deepEqual(sections, ['branches', 'remote']);
    assert.ok(
      !all.some((r) => r.kind === 'group'),
      'no collapsible group rows remain',
    );
  });

  it('a branch with a checkout is not repeated under Branches', async () => {
    const checkouts = (await rows())
      .filter((r) => r.kind === 'worktreeList')
      .map((r) => r.label);
    const branchSection = await sectionAt('branches');
    for (const c of checkouts) {
      assert.ok(
        !branchSection.includes(c),
        `${c} has a checkout and must not also be a branch row`,
      );
    }
  });

  it('a branch moves out of the Branches section when it gets a checkout', async () => {
    git(repo, ['branch', 'feat/focus-demo', 'main']);
    await poll('new branch shows under Branches', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await sectionAt('branches')).includes('feat/focus-demo');
    });

    git(repo, [
      'worktree', 'add', '-q', '.worktrees/focus-demo', 'feat/focus-demo',
    ]);
    await poll('it becomes a checkout row', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (await rows()).some(
        (r) => r.kind === 'worktreeList' && r.label === 'feat/focus-demo',
      );
    });
    assert.ok(
      !(await sectionAt('branches')).includes('feat/focus-demo'),
      'and it leaves the Branches section — never in both',
    );

    git(repo, ['worktree', 'remove', '--force', '.worktrees/focus-demo']);
    git(repo, ['branch', '-D', 'feat/focus-demo']);
    await poll('cleanup settles', 30000, async () => {
      await run('worktreeCompare.refresh');
      return !(await labels()).includes('feat/focus-demo');
    });
  });

  it('folds a section away and back from its separator', async () => {
    const before = await sectionAt('branches');
    assert.ok(before.length > 0, 'Branches starts open with rows in it');

    await run('worktreeCompare.toggleFocusSection', 'branches');
    assert.deepEqual(await sectionAt('branches'), [], 'folded away');
    // Folding one section must not disturb the other, nor the checkouts
    assert.ok(
      (await rows()).some((r) => r.kind === 'worktreeList'),
      'checkouts are untouched by the fold',
    );

    await run('worktreeCompare.toggleFocusSection', 'branches');
    assert.deepEqual(await sectionAt('branches'), before, 'and back again');
  });

  it('keeps the integration branch out of the list entirely', async () => {
    assert.ok(
      !(await labels()).some((l) => l.startsWith('integration/')),
      'the integration branch is the panel subject, not a row',
    );
  });
});
