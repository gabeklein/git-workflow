import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applied,
  getApi,
  git,
  laneA,
  poll,
  readLanes,
  repo,
  run,
  working,
  type TestApi,
} from './helpers';

describe('integration basics', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  it('enrolls a lane as a candidate and blocks pushes on the branch', async () => {
    // Discovery warm-up: keep nudging until the provider knows the lane
    await poll('lane feat/a becomes an integration candidate', 30000, async () => {
      await run('worktreeCompare.addToIntegration', { worktreePath: laneA });
      return readLanes('focus-candidates').includes('feat/a');
    });
    assert.equal(
      git(repo, ['config', 'branch.integration/main.pushRemote']),
      'no_push',
      'push-block config was applied to the integration branch',
    );
  });

  it('applies the lane into a clean integration checkout', async () => {
    await run('worktreeCompare.applyToIntegration', { worktreePath: laneA });
    await poll('integration checkout contains a.txt after apply', 20000, () =>
      fs.existsSync(path.join(working, 'a.txt')),
    );
    assert.ok(applied().includes('feat/a'), 'feat/a is applied');
    assert.equal(
      git(working, ['status', '--porcelain']).length,
      0,
      'integration checkout is clean after rebuild',
    );
    assert.ok(
      api.integration()?.lanes.includes('feat/a'),
      'view state: integration panel shows feat/a applied',
    );
  });
});
