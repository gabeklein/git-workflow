import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applied,
  getApi,
  git,
  poll,
  readLanes,
  repo,
  run,
  working,
  type TestApi,
} from './helpers';

describe('dead lane prune', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  const candidates = () => api.integration()?.candidates ?? [];

  it('drops a deleted branch from every state file', async () => {
    // A lane that will "die": applied, wip-flagged, then branch-deleted
    const laneDead = path.join(repo, '.worktrees', 'feat-dead');
    git(repo, ['fetch', '-q', 'origin']);
    git(repo, [
      'worktree', 'add', '-q', '.worktrees/feat-dead', '-b', 'feat/dead', 'origin/main',
    ]);
    fs.writeFileSync(path.join(laneDead, 'dead.txt'), 'short-lived\n');
    git(laneDead, ['add', '-A']);
    git(laneDead, ['commit', '-qm', 'feat/dead work']);
    await poll('feat/dead applies to integration', 30000, async () => {
      await run('worktreeCompare.applyToIntegration', { worktreePath: laneDead });
      return applied().includes('feat/dead');
    });

    // Seed the other state files the way the shell script / agents can:
    // wip flag on the doomed lane, plus a branch that never existed at all
    // (the mistyped-entry case) straight into focus-candidates.
    const stateFile = (f: string) => path.join(repo, '.git', f);
    fs.appendFileSync(stateFile('focus-wip'), 'feat/dead\n');
    fs.appendFileSync(stateFile('focus-candidates'), 'feat/never-existed\n');

    // Kill the worktree AND the branch — the "worktree died" shape
    git(repo, ['worktree', 'remove', '--force', '.worktrees/feat-dead']);
    git(repo, ['branch', '-D', 'feat/dead']);

    await poll('dead + ghost lanes are pruned from every state file', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (
        !applied().includes('feat/dead') &&
        !readLanes('focus-candidates').includes('feat/dead') &&
        !readLanes('focus-candidates').includes('feat/never-existed') &&
        !readLanes('focus-wip').includes('feat/dead')
      );
    });
  });

  it('keeps live lanes and drops the dead content from the tree', async () => {
    await poll('view state: dead lane leaves the Integration panel', 15000, () =>
      !candidates().includes('feat/dead') &&
      !candidates().includes('feat/never-existed'),
    );
    assert.ok(
      applied().includes('feat/p1') && applied().includes('feat/p2'),
      'live lanes survive the prune',
    );
    await poll('integration tree drops the dead lane content', 20000, () =>
      !fs.existsSync(path.join(working, 'dead.txt')),
    );
    assert.ok(!api.integration()?.error, 'no integration error state after prune');
  });
});
