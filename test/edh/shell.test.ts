/**
 * Driving the preview from a shell, in a repo the extension is actually
 * managing.
 *
 * The unit layer pins the operations and the lock; this pins the wiring
 * that cannot be faked — that the running extension records the settings
 * and the recipe a shell needs, and that an agent's terminal then drives
 * the very same preview the sidebar is showing.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  applied,
  getApi,
  git,
  lane,
  poll,
  previewRoot,
  repo,
  type TestApi,
} from './helpers';

describe('preview from a shell', () => {
  let api: TestApi;
  const common = path.join(repo, '.git');
  const read = (file: string) =>
    fs.readFileSync(path.join(common, file), 'utf8');

  /**
   * Stand the editor's auto-rebuild down for these scenarios.
   *
   * The lock is exclusion, not a queue: whoever calls mkdir first wins, so
   * a writer that re-takes it the moment it lets go can starve one that is
   * waiting. The engine waits a full minute (LOCK_WAIT_MS) and CI still
   * came back "busy" — the fixture has seven worktrees, and every
   * discovery pass can trigger another rebuild, so the editor was never
   * quiet for as long as `gw-lane add` needed.
   *
   * What is under test here is that a SHELL drives the real preview, not
   * who wins a race for the lock; contention has its own scenario below.
   * So remove the competitor rather than hoping to outrun it — and leave
   * `lane()`'s retry in place for the ordinary brief overlap.
   */
  const config = () => vscode.workspace.getConfiguration('worktreeCompare');

  before(async () => {
    api = await getApi();
    await config().update(
      'previewAutoRebuild',
      false,
      vscode.ConfigurationTarget.Workspace,
    );
  });

  after(async () => {
    await config().update(
      'previewAutoRebuild',
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
  });

  it('records the settings and the recipe a shell needs', async () => {
    await poll('the editor writes focus-config and focus-runner', 20000, () => {
      return (
        fs.existsSync(path.join(common, 'focus-config')) &&
        fs.existsSync(path.join(common, 'focus-runner'))
      );
    });
    const config = read('focus-config');
    // Resolved values, not templates: a shell cannot substitute {base}.
    // The base is whatever THIS repo is configured with (the fixture uses
    // the plain branch name), so pin the shape rather than a guess.
    assert.match(config, /^branch: preview\/main$/m);
    assert.match(config, /^base: (origin\/)?main$/m);
    assert.match(config, new RegExp(`^checkout: ${previewRoot}$`, 'm'));

    const script = read('focus-runner')
      .split('\n')
      .find((l) => l.startsWith('script:'))
      ?.slice('script:'.length)
      .trim();
    assert.ok(script && fs.existsSync(script), `the bundle exists: ${script}`);
  });

  /**
   * The agent's route, end to end: a shell runs the bundle, it performs a
   * real rebuild of the real preview, and the answer comes back on exit.
   * Nothing here goes through a VS Code command.
   */
  it('gw-lane rebuild drives the same preview the sidebar shows', async () => {
    const cli = path.join(common, 'gw-lane');
    assert.ok(fs.existsSync(cli), 'the lane CLI is installed while preview is on');

    // A lane with content nobody has merged yet, added the headless way
    const wt = path.join(repo, '.worktrees', 'feat-shell');
    git(repo, ['worktree', 'add', '-q', '.worktrees/feat-shell', '-b', 'feat/shell', 'origin/main']);
    fs.writeFileSync(path.join(wt, 'shell.txt'), 'from the shell lane\n');
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-qm', 'shell lane']);
    await lane(['add', 'feat/shell']);
    assert.ok(applied().includes('feat/shell'), 'gw-lane add applied it');

    const out = await lane(['rebuild']);
    assert.match(out, /^rebuilt: /, `rebuild reported success: ${out}`);
    assert.ok(
      fs.existsSync(path.join(previewRoot, 'shell.txt')),
      'the lane is in the preview tree',
    );
    // …and the editor sees the same preview, without being told: the
    // rebuild moved refs, which its .git watch notices on its own
    await poll('the sidebar catches up with the headless rebuild', 20000, () =>
      (api.preview()?.lanes ?? []).includes('feat/shell'),
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

  /**
   * Nothing stays resident, so the lock is transient: whoever is writing
   * finishes and lets go. POLLED, not asserted once — a rebuild the editor
   * started may still be running, and "somebody is writing right now" is a
   * correct answer, just not the final one. Asserting it once assumed a
   * quiescence CI does not owe us, and CI said so.
   */
  it('lets go of the lock: no writer outlives its operation', async () => {
    const cli = path.join(common, 'gw-lane');
    const owner = (): { status: number; out: string } => {
      try {
        return {
          status: 0,
          out: execFileSync(cli, ['owner'], { cwd: repo, encoding: 'utf8' }),
        };
      } catch (err) {
        const e = err as { status?: number; stdout?: string };
        return { status: e.status ?? -1, out: String(e.stdout ?? '') };
      }
    };
    let last = '';
    await poll('every writer finishes and releases the lock', 30000, () => {
      const answer = owner();
      last = answer.out;
      // exit 1 = nobody holds it; 0 = somebody does, so keep waiting
      return answer.status === 1;
    });
    assert.match(last, /nobody is writing the preview/);

    // Leaving the lane out again keeps later scenarios on the state they expect
    await lane(['remove', 'feat/shell']);
    git(repo, ['worktree', 'remove', '--force', '.worktrees/feat-shell']);
    git(repo, ['branch', '-D', 'feat/shell']);
  });
});
