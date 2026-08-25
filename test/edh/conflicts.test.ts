/**
 * Integration resilience to messy lanes: petty conflicts resolved
 * best-effort instead of failing the rebuild, and dead lanes (deleted
 * branches) pruned from the state files instead of lingering as ghosts.
 */
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
    // Poll, don't assert: the tree content lands (reset --hard inside the
    // rebuild) a beat before the controller assigns autoResolved state.
    await poll('union resolution reported as lossless (no tag-worthy loss)', 15000, () => {
      const r = (api.integration()?.autoResolved ?? []).find(
        (l) => l.lane === 'feat/p2',
      );
      return Boolean(r && r.lossless.includes('news.txt') && r.lossy.length === 0);
    });
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
    // Same content-before-state window as the lossless case above
    await poll('dropped-hunk resolution is tagged lossy on the lane', 15000, () => {
      const r = (api.integration()?.autoResolved ?? []).find(
        (l) => l.lane === 'feat/p2',
      );
      return Boolean(r && r.lossy.includes('news.txt'));
    });
    assert.ok(
      applied().includes('feat/p1') && applied().includes('feat/p2'),
      'both lanes stay applied — the rebuild did not fail',
    );
    assert.ok(!api.integration()?.error, 'no integration error state');
  });
});

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
    // Nudge: the fingerprint-triggered rebuild after a prune is timing-
    // dependent on slow CI — a manual rebuild reads the pruned lane files
    // deterministically (the prune itself was asserted above).
    await poll('integration tree drops the dead lane content', 30000, async () => {
      await run('worktreeCompare.rebuildIntegration');
      return !fs.existsSync(path.join(working, 'dead.txt'));
    });
    assert.ok(!api.integration()?.error, 'no integration error state after prune');
  });
});
