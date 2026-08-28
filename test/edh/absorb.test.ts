/**
 * Rescuing stray work from the preview checkout. The tree there is
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
import {
  getApi,
  git,
  gitOk,
  poll,
  repo,
  run,
  previewRoot,
  type TestApi,
} from './helpers';

describe('absorbing stray preview work', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  it('refuses a plain commit on the preview branch', async () => {
    // The guard runs before absorb ever gets involved: absorb can only aim
    // at the BASE, which is the wrong destination when the work belonged to
    // a lane, so the hook stops the commit while the author still knows
    // which branch they meant.
    fs.appendFileSync(path.join(previewRoot, 'README.md'), 'blocked write\n');
    git(previewRoot, ['add', '-A']);
    const before = git(previewRoot, ['rev-parse', 'HEAD']);
    await poll('pre-commit guard is installed', 30000, () =>
      fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')),
    );
    assert.equal(
      gitOk(previewRoot, ['commit', '-qm', 'should never exist']),
      false,
      'the hook refused the commit',
    );
    assert.equal(
      git(previewRoot, ['rev-parse', 'HEAD']),
      before,
      'HEAD did not move',
    );
    // The staged work is untouched — that is what makes the refusal safe.
    git(previewRoot, ['reset', '-q', '--hard', 'HEAD']);
  });

  it('moves an EDIT made on the preview checkout onto main by itself', async () => {
    // An edit carries diff context, so a replay onto the base is vetted by
    // git itself — safe to move unattended. README.md is on the base and
    // no lane touches it.
    fs.appendFileSync(path.join(previewRoot, 'README.md'), 'an agent wrote here\n');
    git(previewRoot, ['add', '-A']);
    git(previewRoot, ['commit', '--no-verify', '-qm', 'agent edits README on preview']);
    const strayTip = git(previewRoot, ['rev-parse', 'HEAD']);

    // No command: the tick's fingerprint carries a stray component, so the
    // rebuild that trips the guard also runs the rescue.
    //
    // 60s, deliberately: the tick is watcher-driven, and when a .git event
    // is missed or coalesced the next one comes from GitActivityHub's
    // POLL_FALLBACK_MS fallback — 30s. Latency here is bimodal, sub-second
    // or a random slice of that window, so the bound has to clear 30s plus
    // a rebuild or this flakes on a loaded runner. Nudging with a manual
    // rebuild would be faster but would stop testing the tick path, which
    // is the whole point of this scenario.
    //
    // BOTH halves in the one poll: absorb replays onto main and THEN
    // rewinds the checkout, so waiting only on main and asserting the
    // rewind straight after is a race that loses about one run in five.
    await poll('stray edit lands on main and the checkout rewinds', 60000, () => {
      const landed = git(repo, ['log', 'main', '-5', '--format=%s']).includes(
        'agent edits README on preview',
      );
      return landed && git(previewRoot, ['rev-parse', 'HEAD']) !== strayTip;
    });
    assert.ok(
      fs.readFileSync(path.join(repo, 'README.md'), 'utf8').includes(
        'an agent wrote here',
      ),
      'the edit came with it',
    );
  });

  it('holds a commit that ADDS files while lanes are applied', async () => {
    // An added file has no diff context, so it would apply to the base
    // cleanly even if its contents depend on merged lane code. That one
    // shape asks first instead of moving unattended.
    fs.writeFileSync(path.join(previewRoot, 'stray-new.txt'), 'needs the lanes\n');
    git(previewRoot, ['add', '-A']);
    git(previewRoot, ['commit', '--no-verify', '-qm', 'agent adds a file on preview']);

    // 60s for the same reason the poll above it is 60s: this waits on the
    // same watcher-driven tick, so when a .git event is missed the next one
    // comes from the 30s POLL_FALLBACK_MS. 40s left only 10s for a rebuild
    // after the worst-case wait, which is enough on a quiet laptop and not
    // on a loaded CI runner — where it duly failed.
    await poll('the rebuild guard trips and the file is NOT moved', 60000, () => {
      const error = api.preview()?.error as { code?: string } | undefined;
      return (
        error?.code === 'unique' &&
        !fs.existsSync(path.join(repo, 'stray-new.txt'))
      );
    });
    assert.ok(
      !git(repo, ['log', 'main', '-5', '--format=%s']).includes(
        'agent adds a file on preview',
      ),
      'nothing was absorbed automatically',
    );
  });

  it('absorbs the held commit once asked explicitly', async () => {
    await run('worktreeCompare.absorbPreviewCommits');
    await poll('the added file reaches main on command', 30000, () =>
      fs.existsSync(path.join(repo, 'stray-new.txt')),
    );
    assert.equal(
      fs.readFileSync(path.join(repo, 'stray-new.txt'), 'utf8'),
      'needs the lanes\n',
    );
  });

  it('rebuilds cleanly afterwards — the guard is no longer tripped', async () => {
    await run('worktreeCompare.rebuildPreview');
    await poll('preview rebuilds without the unique guard', 30000, () => {
      const error = api.preview()?.error as { code?: string } | undefined;
      return error?.code !== 'unique';
    });
    assert.equal(
      git(previewRoot, ['status', '--porcelain']),
      '',
      'preview checkout is clean after the recovery rebuild',
    );
  });

  it('absorbed work shows up as ordinary base drift, not as a lane', async () => {
    // main is now ahead of the frozen pin — the existing drift row owns it,
    // so the rescue needs no exits of its own.
    await poll('drift row reflects the absorbed commit', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (api.preview()?.baseDrift?.ahead ?? 0) > 0;
    });
  });

  it('moves UNCOMMITTED edits only when asked, and cleans the checkout', async () => {
    fs.writeFileSync(path.join(previewRoot, 'edit.txt'), 'uncommitted agent edit\n');
    assert.notEqual(
      git(previewRoot, ['status', '--porcelain']),
      '',
      'the preview checkout is dirty before the command',
    );
    await run('worktreeCompare.absorbPreviewEdits');
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
      !fs.existsSync(path.join(previewRoot, 'edit.txt')),
      'the preview checkout was restored, untracked file included',
    );
  });
});
