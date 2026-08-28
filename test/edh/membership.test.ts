/**
 * How lanes join and leave Preview on their own: auto-membership by
 * matching base (with a persistent Remove exit), and the opt-in
 * auto-rebase of unpushed lanes.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  getApi,
  git,
  gitOk,
  landing,
  poll,
  readLanes,
  repo,
  run,
  sleep,
  type TestApi,
} from './helpers';

describe('auto membership', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  const candidates = () => api.preview()?.candidates ?? [];
  const appliedInView = () => api.preview()?.lanes ?? [];

  it('auto-enrolls a lane based on the preview base; stacked lanes stay out', async () => {
    // A fresh worktree based on main should enroll with NO add command;
    // a lane stacked on feat/c (its base is its parent branch) must not.
    //
    // `main` explicitly, never the root checkout's HEAD: the root IS the
    // preview, so a bare `git branch` here would cut from a derived merge
    // of the lanes and the new branch's base would not be main at all.
    git(repo, ['branch', 'feat/c', 'main']);
    git(repo, ['worktree', 'add', '-q', '.worktrees/feat-c', 'feat/c']);
    git(repo, ['branch', 'feat/stack', 'feat/c']);
    git(repo, ['worktree', 'add', '-q', '.worktrees/feat-stack', 'feat/stack']);
    await poll('feat/c auto-enrolls (its base matches)', 30000, async () => {
      await run('worktreeCompare.refresh');
      return candidates().includes('feat/c');
    });
    assert.ok(
      !candidates().includes('feat/stack'),
      'stacked lane (based on feat/c) is NOT auto-enrolled',
    );
  });

  it('enrolls the empty lane WITHOUT applying it — inclusion is opt-in', async () => {
    // Being mergeable is not a reason to be in someone's preview. An empty
    // lane is a candidate on sight, so it is visible and one click away,
    // but joining is always a decision somebody made.
    await poll('empty lane shows as a candidate', 30000, async () => {
      await run('worktreeCompare.refresh');
      return candidates().includes('feat/c');
    });
    await sleep(1500);
    assert.ok(
      !appliedInView().includes('feat/c'),
      'the empty lane was not applied by itself',
    );
    assert.ok(
      !readLanes('focus-applied').includes('feat/c'),
      'nothing was persisted to focus-applied',
    );
    assert.ok(
      !(api.preview()?.landed ?? []).includes('feat/c'),
      'an empty lane is not "landed" — it has nothing to retire',
    );
  });

  it('re-points an empty lane cut from a stale base, without applying it', async () => {
    // Cut from main's PARENT: empty, but behind — nothing to rebase, so
    // the lane is moved rather than left reporting a rebase it cannot do.
    const stale = git(repo, ['rev-parse', 'origin/main~1']);
    git(repo, ['branch', 'feat/stale', stale]);
    // Branching at a SHA records that sha in the reflog, so inference would
    // never land on main. State the base outright — the same override
    // branchify writes — so the scenario tests the fast-forward, not the
    // guessing.
    git(repo, ['config', 'branch.feat/stale.vscode-merge-base', 'main']);
    git(repo, ['worktree', 'add', '-q', '.worktrees/feat-stale', 'feat/stale']);
    // The re-point survives opt-in lanes: it is not about membership, it is
    // about an empty lane starting from the right place when its first
    // commit lands.
    await poll('stale empty lane is fast-forwarded', 30000, async () => {
      await run('worktreeCompare.refresh');
      return (
        git(repo, ['rev-parse', 'feat/stale']) ===
        git(repo, ['rev-parse', 'origin/main'])
      );
    });
    assert.ok(
      !appliedInView().includes('feat/stale'),
      'moving a lane is not the same as enrolling it in the preview',
    );
    // Leave no lane behind — later scenarios are sequential and stateful
    git(repo, ['worktree', 'remove', '--force', '.worktrees/feat-stale']);
    git(repo, ['branch', '-D', 'feat/stale']);
    await poll('the temporary lane is pruned again', 30000, async () => {
      await run('worktreeCompare.refresh');
      return !candidates().includes('feat/stale');
    });
  });

  it('Remove is a real exit: the exclusion persists across refreshes', async () => {
    await run('worktreeCompare.removeFromPreview', { branch: 'feat/c' });
    await poll('removed auto member disappears', 20000, () =>
      !candidates().includes('feat/c'),
    );
    assert.ok(
      readLanes('focus-excluded').includes('feat/c'),
      'exclusion persisted to focus-excluded',
    );
    await run('worktreeCompare.refresh');
    await sleep(1500);
    assert.ok(
      !candidates().includes('feat/c'),
      'excluded member stays gone after a refresh',
    );
  });

  it('Add to Preview is the way back — it clears the exclusion', async () => {
    await run('worktreeCompare.addToPreview', {
      worktreePath: path.join(repo, '.worktrees', 'feat-c'),
    });
    await poll('re-added member returns', 20000, () =>
      candidates().includes('feat/c'),
    );
    assert.ok(
      !readLanes('focus-excluded').includes('feat/c'),
      'exclusion cleared on re-add',
    );
  });
});

describe('auto rebase (autoRebaseLanes=local-only)', () => {
  const laneC = path.join(repo, '.worktrees', 'feat-c');
  const config = () => vscode.workspace.getConfiguration('worktreeCompare');
  let api: TestApi;
  let featATip: string;

  const rebasePaused = (): boolean => {
    const p = git(laneC, ['rev-parse', '--git-path', 'rebase-merge']);
    return fs.existsSync(path.resolve(laneC, p));
  };

  before(async () => {
    api = await getApi();
    // Give feat/c its own commit so catch-up is a real rebase. It is
    // unpushed (no origin/feat/c) — exactly the auto-eligible shape.
    fs.writeFileSync(path.join(laneC, 'c.txt'), 'lane c v1\n');
    git(laneC, ['add', 'c.txt']);
    git(laneC, ['commit', '-qm', 'feat c']);
    featATip = git(repo, ['rev-parse', 'feat/a']);
    await config().update(
      'autoRebaseLanes',
      'local-only',
      vscode.ConfigurationTarget.Workspace,
    );
  });

  after(async () => {
    await config().update(
      'autoRebaseLanes',
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
  });

  it('auto-rebases an unpushed lane onto the base', async () => {
    await poll('unpushed lane auto-rebases onto the base', 30000, async () => {
      await api.refreshBaseStatuses();
      return gitOk(repo, ['merge-base', '--is-ancestor', 'origin/main', 'feat/c']);
    });
    assert.ok(!rebasePaused(), 'auto attempt left no paused rebase behind');
    assert.equal(
      git(repo, ['show', 'feat/c:c.txt']).trim(),
      'lane c v1',
      'auto-rebased tip still carries the lane commit',
    );
  });

  it('marks a conflicting lane instead of attempting it; never rewrites pushed lanes', async () => {
    // Base gains a conflicting c.txt → lane must be MARKED, not attempted
    fs.writeFileSync(path.join(landing, 'c.txt'), 'base disagrees on c\n');
    git(landing, ['add', 'c.txt']);
    git(landing, ['commit', '-qm', 'base adds c.txt']);
    git(landing, ['push', '-q']);
    git(repo, ['fetch', '-q', 'origin']);
    const cTip = git(repo, ['rev-parse', 'feat/c']);
    await poll('conflicting lane gets the badge instead of an attempt', 30000, async () => {
      await api.refreshBaseStatuses();
      return api.baseStatus(laneC)?.conflicts === true;
    });
    assert.equal(
      git(repo, ['rev-parse', 'feat/c']),
      cTip,
      'conflicting lane tip is untouched',
    );
    assert.ok(!rebasePaused(), 'no paused rebase after the conflict pass');
    // feat/a is behind now too, but pushed — auto must never rewrite it
    assert.equal(
      git(repo, ['rev-parse', 'feat/a']),
      featATip,
      'pushed lane feat/a is never auto-rewritten',
    );
  });
});
