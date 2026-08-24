/**
 * What happens as PRs land and the base moves: the landed predicate
 * (true-merge, squash, revert-safety) and the lane-vs-base badges.
 */
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

describe('base badges', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  it('shows behind-base when the remote base advances past the lane', async () => {
    fs.writeFileSync(path.join(landing, 'news.txt'), 'base moved\n');
    git(landing, ['add', 'news.txt']);
    git(landing, ['commit', '-qm', 'base advances']);
    git(landing, ['push', '-q']);
    await run('worktreeCompare.rebuildIntegration');
    await api.refreshBaseStatuses();
    await poll('view state: lane shows behind-base badge', 15000, async () => {
      await api.refreshBaseStatuses();
      const s = api.baseStatus(laneA);
      return Boolean(s && s.behind >= 1 && !s.conflicts);
    });
  });

  it('shows conflicts-with-base on a conflicting base change (strict probe)', async () => {
    fs.writeFileSync(path.join(landing, 'a.txt'), 'base disagrees\n');
    git(landing, ['add', 'a.txt']);
    git(landing, ['commit', '-qm', 'base rewrites a.txt']);
    git(landing, ['push', '-q']);
    // feat/a is landed/retired; give it a new commit so it diverges again
    fs.writeFileSync(path.join(laneA, 'a.txt'), 'lane insists\n');
    git(laneA, ['add', 'a.txt']);
    git(laneA, ['commit', '-qm', 'lane edits a.txt']);
    await run('worktreeCompare.rebuildIntegration');
    // 30s: this depends on the manual rebuild's base fetch having landed,
    // which can queue behind an in-flight rebuild (observed flaking at 15s)
    await poll('view state: lane shows conflicts-with-base badge', 30000, async () => {
      await api.refreshBaseStatuses();
      return api.baseStatus(laneA)?.conflicts === true;
    });
  });
});
