import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  getApi,
  git,
  poll,
  readLanes,
  repo,
  run,
  sleep,
  type TestApi,
} from './helpers';

describe('auto membership', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  const candidates = () => api.integration()?.candidates ?? [];

  it('auto-enrolls a lane based on the integration base; stacked lanes stay out', async () => {
    // A fresh worktree based on main should enroll with NO add command;
    // a lane stacked on feat/c (its base is its parent branch) must not.
    git(repo, ['branch', 'feat/c']);
    git(repo, ['worktree', 'add', '-q', '.worktrees/feat-c', 'feat/c']);
    git(repo, ['branch', 'feat/stack', 'feat/c']);
    git(repo, ['worktree', 'add', '-q', '.worktrees/feat-stack', 'feat/stack']);
    await poll('feat/c auto-enrolls (its base matches)', 30000, async () => {
      await run('worktreeCompare.refresh');
      return candidates().includes('feat/c');
    });
    assert.ok(
      !candidates().includes('feat/stack'),
      'stacked lane (based on feat/c) is NOT auto-enrolled',
    );
    assert.ok(
      !readLanes('focus-candidates').includes('feat/c'),
      'auto member is derived, not written to focus-candidates',
    );
  });

  it('Remove is a real exit: the exclusion persists across refreshes', async () => {
    await run('worktreeCompare.removeFromIntegration', { branch: 'feat/c' });
    await poll('removed auto member disappears', 20000, () =>
      !candidates().includes('feat/c'),
    );
    assert.ok(
      readLanes('focus-excluded').includes('feat/c'),
      'exclusion persisted to focus-excluded',
    );
    await run('worktreeCompare.refresh');
    await sleep(1500);
    assert.ok(
      !candidates().includes('feat/c'),
      'excluded member stays gone after a refresh',
    );
  });

  it('Add to Integration is the way back — it clears the exclusion', async () => {
    await run('worktreeCompare.addToIntegration', {
      worktreePath: path.join(repo, '.worktrees', 'feat-c'),
    });
    await poll('re-added member returns', 20000, () =>
      candidates().includes('feat/c'),
    );
    assert.ok(
      !readLanes('focus-excluded').includes('feat/c'),
      'exclusion cleared on re-add',
    );
  });
});
