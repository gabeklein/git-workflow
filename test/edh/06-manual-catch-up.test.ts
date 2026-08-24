import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  fire,
  getApi,
  git,
  gitOk,
  landing,
  laneA,
  laneB,
  poll,
  repo,
  sleep,
  type TestApi,
} from './helpers';

describe('manual catch-up', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
    // laneA still carries the uncommitted wip.txt from the wip scenario —
    // catch-up ops refuse dirty worktrees (as they must), so clean it up
    fs.rmSync(path.join(laneA, 'wip.txt'), { force: true });
  });

  const rebasePaused = (): boolean => {
    const p = git(laneA, ['rev-parse', '--git-path', 'rebase-merge']);
    return fs.existsSync(path.resolve(laneA, p));
  };

  it('pauses a conflicted rebase visibly; Abort restores the tip', async () => {
    const tipBefore = git(repo, ['rev-parse', 'feat/a']);
    fire('worktreeCompare.rebaseOntoBase', { worktreePath: laneA });
    await poll('conflicted rebase pauses (row shows rebasing)', 20000, async () => {
      await api.refreshBaseStatuses();
      return rebasePaused() && api.baseStatus(laneA)?.rebasing === true;
    });
    fire('worktreeCompare.abortRebase', { worktreePath: laneA });
    await poll('abort restores the lane tip', 20000, async () => {
      await api.refreshBaseStatuses();
      return (
        !rebasePaused() &&
        git(repo, ['rev-parse', 'feat/a']) === tipBefore &&
        api.baseStatus(laneA)?.rebasing !== true
      );
    });
  });

  it('Continue refuses on conflict markers, then finishes once resolved', async () => {
    fire('worktreeCompare.rebaseOntoBase', { worktreePath: laneA });
    await poll('rebase pauses again for the continue flow', 20000, () =>
      rebasePaused(),
    );
    fire('worktreeCompare.continueRebase', { worktreePath: laneA });
    await sleep(1500);
    assert.ok(
      rebasePaused(),
      'Continue Rebase refuses while conflict markers remain',
    );
    fs.writeFileSync(path.join(laneA, 'a.txt'), 'lane and base agree\n');
    fire('worktreeCompare.continueRebase', { worktreePath: laneA });
    await poll('continue finishes the rebase onto the base', 20000, () =>
      !rebasePaused() &&
      gitOk(repo, ['merge-base', '--is-ancestor', 'origin/main', 'feat/a']),
    );
    assert.equal(
      git(repo, ['show', 'feat/a:a.txt']).trim(),
      'lane and base agree',
      'rebased tip carries the resolved content',
    );
  });

  it('clean catch-up honors catchUpStrategy (explicit rebase, no pause)', async () => {
    const config = vscode.workspace.getConfiguration('worktreeCompare');
    await config.update('catchUpStrategy', 'rebase', vscode.ConfigurationTarget.Workspace);
    try {
      fire('worktreeCompare.catchUpWithBase', { worktreePath: laneB });
      await poll('clean rebase catches feat/b up with the base', 20000, () =>
        gitOk(repo, ['merge-base', '--is-ancestor', 'origin/main', 'feat/b']),
      );
    } finally {
      await config.update('catchUpStrategy', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  it('conflicted merge from base pauses; Complete commits the resolution', async () => {
    fs.writeFileSync(path.join(landing, 'a.txt'), 'base moves on\n');
    git(landing, ['add', 'a.txt']);
    git(landing, ['commit', '-qm', 'base edits a.txt again']);
    git(landing, ['push', '-q']);
    git(laneA, ['fetch', '-q', 'origin']);
    fire('worktreeCompare.mergeFromBase', { worktreePath: laneA });
    await poll('conflicted merge pauses (row shows merging base)', 20000, async () => {
      await api.refreshBaseStatuses();
      return (
        gitOk(laneA, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']) &&
        api.baseStatus(laneA)?.merging === true
      );
    });
    fs.writeFileSync(path.join(laneA, 'a.txt'), 'merged: both sides\n');
    fire('worktreeCompare.completeMergeFromBase', { worktreePath: laneA });
    await poll('complete commits the merge (two parents, clean tree)', 20000, () =>
      !gitOk(laneA, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']) &&
      gitOk(repo, ['rev-parse', '--verify', 'feat/a^2']) &&
      git(laneA, ['status', '--porcelain']).length === 0,
    );
  });
});
