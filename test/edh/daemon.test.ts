/**
 * The single writer, in a repo the extension is actually managing.
 *
 * The unit layer pins the queue and the daemon's behaviour; this pins the
 * wiring that cannot be faked — that the running extension records how to
 * start a daemon and what settings it should serve, and that an agent's
 * shell can then drive the very same preview the sidebar is showing.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applied,
  getApi,
  git,
  poll,
  previewRoot,
  repo,
  type TestApi,
} from './helpers';

describe('preview daemon', () => {
  let api: TestApi;
  const common = path.join(repo, '.git');
  const read = (file: string) =>
    fs.readFileSync(path.join(common, file), 'utf8');

  before(async () => {
    api = await getApi();
  });

  it('records the settings and the recipe for starting one', async () => {
    await poll('the editor writes focus-config and focus-daemon-cmd', 20000, () => {
      return (
        fs.existsSync(path.join(common, 'focus-config')) &&
        fs.existsSync(path.join(common, 'focus-daemon-cmd'))
      );
    });
    const config = read('focus-config');
    // Resolved values, not templates: a daemon cannot substitute {base}.
    // The base is whatever THIS repo is configured with (the fixture uses
    // the plain branch name), so pin the shape rather than a guess.
    assert.match(config, /^branch: preview\/main$/m);
    assert.match(config, /^base: (origin\/)?main$/m);
    assert.match(config, new RegExp(`^checkout: ${previewRoot}$`, 'm'));

    const script = read('focus-daemon-cmd')
      .split('\n')
      .find((l) => l.startsWith('script:'))
      ?.slice('script:'.length)
      .trim();
    assert.ok(script && fs.existsSync(script), `daemon bundle exists: ${script}`);
  });

  /**
   * The agent's route, end to end: a shell starts a daemon, it performs a
   * real rebuild of the real preview, and the answer comes back. Nothing
   * here goes through a VS Code command.
   */
  it('gw-lane rebuild drives the same preview the sidebar shows', async () => {
    const cli = path.join(common, 'gw-lane');
    assert.ok(fs.existsSync(cli), 'the lane CLI is installed while preview is on');

    // A lane with content nobody has merged yet, added the headless way
    const wt = path.join(repo, '.worktrees', 'feat-daemon');
    git(repo, ['worktree', 'add', '-q', '.worktrees/feat-daemon', '-b', 'feat/daemon', 'origin/main']);
    fs.writeFileSync(path.join(wt, 'daemon.txt'), 'from the daemon lane\n');
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-qm', 'daemon lane']);
    execFileSync(cli, ['add', 'feat/daemon'], { cwd: repo, encoding: 'utf8' });
    assert.ok(applied().includes('feat/daemon'), 'gw-lane add applied it');

    const out = execFileSync(cli, ['rebuild'], { cwd: repo, encoding: 'utf8' });
    assert.match(out, /^rebuilt: /, `rebuild reported success: ${out}`);
    assert.ok(
      fs.existsSync(path.join(previewRoot, 'daemon.txt')),
      'the lane is in the preview tree',
    );
    // …and the editor sees the same preview, without being told
    await poll('the sidebar catches up with the headless rebuild', 20000, () =>
      (api.preview()?.lanes ?? []).includes('feat/daemon'),
    );
  });

  /**
   * The nudge, for the changes no watcher can see.
   *
   * A file written into a checkout touches nothing under `.git`, so the
   * fs.watch never fires and the ROWS — which come from discovery, not
   * from a live read — keep their old answer until the 30s fallback poll.
   * The root checkout is the probe because it is the one whose dirty state
   * discovery records; the tight timeout is the assertion, since a row
   * that catches up in a couple of seconds did not wait for the poll.
   */
  it('refresh makes the sidebar notice a change no watcher could see', async () => {
    const rootRow = () =>
      (api.worktrees() ?? []).find((w) => w.path === previewRoot);
    assert.equal(rootRow()?.isDirty, false, 'the root checkout starts clean');

    const probe = path.join(previewRoot, 'refresh-probe.txt');
    fs.writeFileSync(probe, 'written straight into the checkout\n');
    const gwLane = path.join(common, 'gw-lane');
    execFileSync(gwLane, ['refresh'], { cwd: repo, encoding: 'utf8' });
    await poll('the row catches up well inside the 30s poll', 8000, () =>
      rootRow()?.isDirty === true,
    );

    // …and back out again: an untracked file survives reset --hard, and
    // every later scenario expects this checkout clean.
    fs.rmSync(probe);
    execFileSync(gwLane, ['refresh'], { cwd: repo, encoding: 'utf8' });
    await poll('and clean again for the scenarios after this one', 8000, () =>
      rootRow()?.isDirty === false,
    );
  });

  it('says who is serving, and stays out of the way when nobody is', () => {
    const cli = path.join(common, 'gw-lane');
    const status = execFileSync(cli, ['status'], { cwd: repo, encoding: 'utf8' });
    assert.match(status, /^daemon: /m, 'status leads with whether one is up');

    // Leaving the lane out again keeps later scenarios on the state they expect
    execFileSync(cli, ['remove', 'feat/daemon'], { cwd: repo, encoding: 'utf8' });
    git(repo, ['worktree', 'remove', '--force', '.worktrees/feat-daemon']);
    git(repo, ['branch', '-D', 'feat/daemon']);
  });
});
