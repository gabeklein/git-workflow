/**
 * The frozen integration base + the drift LANE: commits made directly on
 * the local base branch never retarget the preview (the pin holds) — they
 * ride along as a checkable lane instead, included by default. Uncheck
 * persists; branchify / catch-up / push are the three ways the segment
 * stops existing.
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

describe('base pin & drift lane', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  const drift = () => api.integration()?.baseDrift;
  const pin = () =>
    fs.readFileSync(path.join(repo, '.git', 'focus-base'), 'utf8').trim();

  it('a commit on local main joins the preview as a lane — the base stays frozen', async () => {
    const pinBefore = pin();
    fs.writeFileSync(path.join(repo, 'mainwork.txt'), 'accidental main work\n');
    git(repo, ['add', 'mainwork.txt']);
    git(repo, ['commit', '-qm', 'oops: committed on main']);
    await poll('drift lane appears, included, and its work reaches the preview', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (
        (drift()?.ahead ?? 0) >= 1 &&
        drift()?.included === true &&
        fs.existsSync(path.join(working, 'mainwork.txt'))
      );
    });
    assert.equal(pin(), pinBefore, 'the frozen base (pin) did not move');
  });

  it('unchecking excludes the drift lane, and the choice persists', async () => {
    await api.setBaseDriftIncluded(false);
    await poll('excluded drift work leaves the preview', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (
        drift()?.included === false &&
        !fs.existsSync(path.join(working, 'mainwork.txt'))
      );
    });
    await run('worktreeCompare.refresh');
    assert.equal(
      drift()?.included,
      false,
      'exclusion persists across refreshes',
    );

    await api.setBaseDriftIncluded(true);
    await poll('re-including brings the work back', 30000, () =>
      fs.existsSync(path.join(working, 'mainwork.txt')),
    );
  });

  it('branchify moves the drifted commits into a real lane and resets main', async () => {
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
    await poll('drift lane clears after branchify', 15000, async () => {
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

  it('pushing main lands the drift lane — the frozen base advances', async () => {
    fs.writeFileSync(path.join(repo, 'mainwork3.txt'), 'pushed main work\n');
    git(repo, ['add', 'mainwork3.txt']);
    git(repo, ['commit', '-qm', 'main work that gets published']);
    await poll('drift appears for the third commit', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (drift()?.ahead ?? 0) >= 1;
    });
    git(repo, ['push', '-q', 'origin', 'main']);
    await poll('push clears drift and the work becomes base', 30000, async () => {
      await run('worktreeCompare.refresh');
      return !drift() && fs.existsSync(path.join(working, 'mainwork3.txt'));
    });
  });
});
