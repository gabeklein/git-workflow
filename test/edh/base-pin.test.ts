/**
 * The frozen integration base: commits made directly on the local base
 * branch must never silently retarget the preview — they surface as a
 * drift row with two deliberate exits (branchify, catch up).
 *
 * Runs LAST: it commits directly on local main, which would perturb
 * every earlier scenario's notion of the base.
 */
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

describe('base pin & drift', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  const drift = () => api.integration()?.baseDrift;

  it('freezes the base: a commit on local main surfaces as drift, not a retarget', async () => {
    const workingHeadBefore = git(working, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'mainwork.txt'), 'accidental main work\n');
    git(repo, ['add', 'mainwork.txt']);
    git(repo, ['commit', '-qm', 'oops: committed on main']);
    await poll('drift row appears (+1 not integrated)', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (drift()?.ahead ?? 0) >= 1;
    });
    assert.equal(
      git(working, ['rev-parse', 'HEAD']),
      workingHeadBefore,
      'integration HEAD is frozen — local main commit did not retarget it',
    );
    assert.ok(
      !fs.existsSync(path.join(working, 'mainwork.txt')),
      'unintegrated main work is not in the preview',
    );
  });

  it('branchify moves the drifted commits into a lane and resets main', async () => {
    const driftSha = drift()!.sha;
    const resetTo = drift()!.resetTo;
    await run('worktreeCompare.branchifyBaseDrift', 'feat/main-work');
    await poll('branchified commits reach the preview as a lane', 30000, () =>
      applied().includes('feat/main-work') &&
      fs.existsSync(path.join(working, 'mainwork.txt')),
    );
    assert.equal(
      git(repo, ['rev-parse', 'feat/main-work']),
      driftSha,
      'new branch holds the drifted commit',
    );
    assert.equal(
      git(repo, ['rev-parse', 'main']),
      resetTo,
      'main returned to the frozen base point',
    );
    await poll('drift row clears after branchify', 15000, async () => {
      await run('worktreeCompare.refresh');
      return !drift();
    });
  });

  it('Catch Up advances the frozen base deliberately', async () => {
    fs.writeFileSync(path.join(repo, 'mainwork2.txt'), 'deliberate main work\n');
    git(repo, ['add', 'mainwork2.txt']);
    git(repo, ['commit', '-qm', 'main advances on purpose']);
    await poll('drift reappears for the second commit', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (drift()?.ahead ?? 0) >= 1;
    });
    const mainSha = git(repo, ['rev-parse', 'main']);
    await run('worktreeCompare.catchUpIntegrationBase');
    await poll('catch-up rebases the preview onto the new base', 30000, () => {
      try {
        git(working, ['merge-base', '--is-ancestor', mainSha, 'HEAD']);
        return fs.existsSync(path.join(working, 'mainwork2.txt'));
      } catch {
        return false;
      }
    });
    await poll('drift clears after catch-up', 15000, async () => {
      await run('worktreeCompare.refresh');
      return !drift();
    });
  });
});
