import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applied,
  getApi,
  git,
  poll,
  repo,
  run,
  working,
  type TestApi,
} from './helpers';

describe('petty conflicts (best-effort resolver)', () => {
  let api: TestApi;
  // Two fresh lanes off origin/main, both appending to the same file —
  // the classic changelog/import-list clash that used to fail rebuilds.
  const lanes: Record<string, string> = {};

  before(async () => {
    api = await getApi();
    git(repo, ['fetch', '-q', 'origin']);
    for (const [branch, dir, note] of [
      ['feat/p1', 'feat-p1', '- p1 note'],
      ['feat/p2', 'feat-p2', '- p2 note'],
    ]) {
      const wt = path.join(repo, '.worktrees', dir);
      git(repo, ['worktree', 'add', '-q', `.worktrees/${dir}`, '-b', branch, 'origin/main']);
      fs.appendFileSync(path.join(wt, 'news.txt'), `${note}\n`);
      git(wt, ['add', '-A']);
      git(wt, ['commit', '-qm', `${branch} note`]);
      lanes[branch] = wt;
    }
  });

  it('resolves same-file appends losslessly (union)', async () => {
    for (const branch of ['feat/p1', 'feat/p2']) {
      await poll(`${branch} applies to integration`, 30000, async () => {
        await run('worktreeCompare.applyToIntegration', {
          worktreePath: lanes[branch],
        });
        return applied().includes(branch);
      });
    }
    await poll('both appends survive in the integration tree (union)', 20000, () => {
      const news = path.join(working, 'news.txt');
      if (!fs.existsSync(news)) return false;
      const content = fs.readFileSync(news, 'utf8');
      return content.includes('- p1 note') && content.includes('- p2 note');
    });
    const lossless = (api.integration()?.autoResolved ?? []).find(
      (r) => r.lane === 'feat/p2',
    );
    assert.ok(
      lossless && lossless.lossless.includes('news.txt') && lossless.lossy.length === 0,
      'union resolution reported as lossless (no tag-worthy loss)',
    );
  });

  it('builds best-effort on same-line divergence and tags the row lossy', async () => {
    for (const [branch, headline] of [
      ['feat/p1', 'p1 headline'],
      ['feat/p2', 'p2 headline'],
    ]) {
      const wt = lanes[branch];
      const news = path.join(wt, 'news.txt');
      const linesNow = fs.readFileSync(news, 'utf8').split('\n');
      linesNow[0] = headline;
      fs.writeFileSync(news, linesNow.join('\n'));
      git(wt, ['add', '-A']);
      git(wt, ['commit', '-qm', `${branch} headline`]);
    }
    await run('worktreeCompare.rebuildIntegration');
    await poll('divergent same-line edit builds best-effort (lane wins)', 20000, () => {
      const news = path.join(working, 'news.txt');
      return (
        fs.existsSync(news) &&
        fs.readFileSync(news, 'utf8').startsWith('p2 headline')
      );
    });
    const lossy = (api.integration()?.autoResolved ?? []).find(
      (r) => r.lane === 'feat/p2',
    );
    assert.ok(
      lossy && lossy.lossy.includes('news.txt'),
      'dropped-hunk resolution is tagged lossy on the lane',
    );
    assert.ok(
      applied().includes('feat/p1') && applied().includes('feat/p2'),
      'both lanes stay applied — the rebuild did not fail',
    );
    assert.ok(!api.integration()?.error, 'no integration error state');
  });
});
