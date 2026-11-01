/**
 * A lane's compare base follows the base its open PR targets.
 *
 * The unit layer pins the order of the evidence (resolveBaseRef, and the
 * tracker re-resolving when the PR base it was given changes). This pins
 * the wiring the unit layer cannot reach: that a PR answer arriving — or
 * changing — moves the base the row is measured against, with no full
 * refresh in between. The fixture has no GitHub, so the open-PR list is
 * seeded through the test hooks and associated the way a real answer is.
 *
 * Self-contained: its worktree, branch and remote base are removed after.
 */
import * as assert from 'node:assert/strict';
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

describe('base follows the PR', () => {
  let api: TestApi;
  const branch = 'pr-base';
  const wt = path.join(repo, '.worktrees', 'pr-base');

  const baseRefOf = async (): Promise<string | undefined> => {
    await api.refreshBaseStatuses();
    return api.baseStatus(wt)?.baseRef;
  };

  before(async () => {
    api = await getApi();
    // A second base on the GitHub side for the PR to target
    git(landing, ['fetch', '-q', 'origin']);
    git(landing, ['push', '-q', 'origin', 'origin/main:refs/heads/release']);
    git(repo, ['fetch', '-q', 'origin']);
    git(repo, ['worktree', 'add', '-q', '-b', branch, wt, 'origin/main']);
    await poll('the new worktree is discovered', 20_000, () =>
      api.worktrees().some((w) => w.path === wt),
    );
  });

  after(async () => {
    await api.seedPullRequests([]);
    gitOk(repo, ['worktree', 'remove', '--force', wt]);
    gitOk(repo, ['branch', '-D', branch]);
    gitOk(landing, ['push', '-q', 'origin', '--delete', 'release']);
    // Only this ref: a repo-wide prune would also drop tracking refs
    // earlier scenarios left behind on purpose
    gitOk(repo, ['update-ref', '-d', 'refs/remotes/origin/release']);
    await poll('the worktree is gone from the panel', 20_000, () =>
      api.worktrees().every((w) => w.path !== wt),
    );
  });

  it('measures against where the branch was cut while no PR is known', async () => {
    await poll('base is origin/main', 20_000, async () =>
      (await baseRefOf()) === 'origin/main',
    );
  });

  it("an open PR's base outranks the branch's own evidence", async () => {
    await api.seedPullRequests([
      { number: 41, head: branch, base: 'release' },
    ]);
    await poll('base follows the PR to origin/release', 20_000, async () =>
      (await baseRefOf()) === 'origin/release',
    );
  });

  it("a manual base on a PR lane ends when you leave the lane", async () => {
    const before = api.selectedPath();
    const other = api.worktrees().find((w) => w.path !== wt)?.path;
    assert.ok(other, 'another checkout to step over to');
    await run('worktreeCompare.focusWorktree', wt);
    await api.setBaseRef(wt, 'main');
    await poll('the manual base wins while on the lane', 20_000, async () =>
      (await baseRefOf()) === 'origin/main',
    );
    await run('worktreeCompare.focusWorktree', other);
    await run('worktreeCompare.focusWorktree', wt);
    await poll('coming back finds the PR base again', 20_000, async () =>
      (await baseRefOf()) === 'origin/release',
    );
    if (before) await run('worktreeCompare.focusWorktree', before);
  });

  it('a PR that is no longer open stops speaking for the base', async () => {
    await api.seedPullRequests([]);
    await poll('base falls back to origin/main', 20_000, async () =>
      (await baseRefOf()) === 'origin/main',
    );
    assert.equal(api.baseStatus(wt)?.ahead, 0);
  });
});
