import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applied,
  getApi,
  git,
  landing,
  laneA,
  laneB,
  poll,
  readLanes,
  repo,
  run,
  working,
  type TestApi,
} from './helpers';

describe('landed lifecycle', () => {
  let api: TestApi;
  let squashSha: string;
  before(async () => {
    api = await getApi();
  });

  it('retires a true-merged lane instead of merging it', async () => {
    // True-merge landing on the "GitHub side"
    git(landing, ['fetch', '-q', 'origin']);
    git(landing, ['merge', '-q', '--no-ff', '-m', 'Merge PR feat/a', 'origin/feat/a']);
    git(landing, ['push', '-q']);
    await run('worktreeCompare.rebuildIntegration');
    await run('worktreeCompare.applyToIntegration', { worktreePath: laneA });
    await poll('true-merged lane retires instead of merging', 20000, () => {
      const tree = git(working, ['rev-parse', 'HEAD^{tree}']);
      const base = git(repo, ['rev-parse', 'origin/main^{tree}']);
      return !applied().includes('feat/a') && tree === base;
    });
    assert.ok(
      readLanes('focus-candidates').includes('feat/a'),
      'retired lane stays listed as a candidate',
    );
    await poll('view state: lane shows landed', 15000, () =>
      (api.integration()?.landed ?? []).includes('feat/a'),
    );
  });

  it('retires a squash-landed lane by content', async () => {
    git(landing, ['fetch', '-q', 'origin']);
    git(landing, ['merge', '-q', '--squash', 'origin/feat/b']);
    git(landing, ['commit', '-qm', 'feat b (squash #2)']);
    squashSha = git(landing, ['rev-parse', 'HEAD']);
    git(landing, ['push', '-q']);
    await run('worktreeCompare.rebuildIntegration');
    await run('worktreeCompare.applyToIntegration', { worktreePath: laneB });
    await poll('squash-landed lane retires by content', 20000, () =>
      !applied().includes('feat/b') &&
      fs.existsSync(path.join(working, 'b.txt')),
    );
  });

  it('re-applies a reverted squash as a real merge (revert-safety)', async () => {
    git(landing, ['revert', '--no-edit', squashSha]);
    git(landing, ['push', '-q']);
    await run('worktreeCompare.rebuildIntegration');
    await poll('revert reaches the integration tree', 20000, () =>
      !fs.existsSync(path.join(working, 'b.txt')),
    );
    await run('worktreeCompare.applyToIntegration', { worktreePath: laneB });
    await poll('reverted lane re-applies as a real merge', 20000, () =>
      applied().includes('feat/b') &&
      fs.existsSync(path.join(working, 'b.txt')),
    );
  });
});
