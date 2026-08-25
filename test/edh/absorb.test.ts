/**
 * Rescuing stray work from the integration checkout. The tree there is
 * derived and gets reset on every rebuild, so the guards refuse rather
 * than destroy — absorbing is the exit that keeps the refusal from being
 * a deadlock. Committed strays move on their own; uncommitted edits only
 * ever move on command.
 *
 * Runs LAST: absorbing commits onto main mutates the fixture's base.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getApi, git, poll, repo, run, working, type TestApi } from './helpers';

describe('absorbing stray integration work', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  it('moves a commit made on the integration checkout onto main by itself', async () => {
    fs.writeFileSync(path.join(working, 'stray.txt'), 'an agent wrote here\n');
    git(working, ['add', '-A']);
    git(working, ['commit', '-qm', 'agent commits on integration']);
    const strayTip = git(working, ['rev-parse', 'HEAD']);

    // No command: the tick's fingerprint carries a stray component, so the
    // rebuild that trips the guard also runs the rescue.
    await poll('stray commit lands on main', 40000, () =>
      git(repo, ['log', 'main', '-5', '--format=%s']).includes(
        'agent commits on integration',
      ),
    );
    assert.equal(
      fs.readFileSync(path.join(repo, 'stray.txt'), 'utf8'),
      'an agent wrote here\n',
      'the file content came with it',
    );
    assert.notEqual(
      git(working, ['rev-parse', 'HEAD']),
      strayTip,
      'the integration checkout was rewound off the stray commit',
    );
  });

  it('rebuilds cleanly afterwards — the guard is no longer tripped', async () => {
    await run('worktreeCompare.rebuildIntegration');
    await poll('integration rebuilds without the unique guard', 30000, () => {
      const error = api.integration()?.error as { code?: string } | undefined;
      return error?.code !== 'unique';
    });
    assert.equal(
      git(working, ['status', '--porcelain']),
      '',
      'integration checkout is clean after the recovery rebuild',
    );
  });

  it('absorbed work shows up as ordinary base drift, not as a lane', async () => {
    // main is now ahead of the frozen pin — the existing drift row owns it,
    // so the rescue needs no exits of its own.
    await poll('drift row reflects the absorbed commit', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (api.integration()?.baseDrift?.ahead ?? 0) > 0;
    });
  });

  it('moves UNCOMMITTED edits only when asked, and cleans the checkout', async () => {
    fs.writeFileSync(path.join(working, 'edit.txt'), 'uncommitted agent edit\n');
    assert.notEqual(
      git(working, ['status', '--porcelain']),
      '',
      'the integration checkout is dirty before the command',
    );
    await run('worktreeCompare.absorbIntegrationEdits');
    await poll('uncommitted edits reach main', 30000, () =>
      fs.existsSync(path.join(repo, 'edit.txt')),
    );
    assert.equal(
      fs.readFileSync(path.join(repo, 'edit.txt'), 'utf8'),
      'uncommitted agent edit\n',
    );
    assert.equal(
      git(repo, ['status', '--porcelain', '--', 'edit.txt']).trim(),
      'A  edit.txt',
      'it arrives UNCOMMITTED — absorbing must not decide the work is done',
    );
    assert.ok(
      !fs.existsSync(path.join(working, 'edit.txt')),
      'the integration checkout was restored, untracked file included',
    );
  });
});
