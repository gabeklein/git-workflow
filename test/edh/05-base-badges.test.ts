import * as fs from 'node:fs';
import * as path from 'node:path';
import { getApi, git, landing, laneA, poll, run, type TestApi } from './helpers';

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
