/**
 * Runs INSIDE the Extension Development Host. Drives the extension's real
 * registered commands against the fixture repo and asserts on git state
 * plus view state (via the GW_TEST_HOOKS exports). Scenarios run in order
 * and build on each other; any thrown error fails the run.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const repo = process.env.GW_FIXTURE_REPO;
const landing = process.env.GW_FIXTURE_LANDING;
const laneA = path.join(repo, '.worktrees', 'feat-a');
const laneB = path.join(repo, '.worktrees', 'feat-b');
const working = path.join(repo, '.worktrees', 'working');

/** View-state hooks exported by activate() under GW_TEST_HOOKS. */
let api;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function readLanes(file) {
  try {
    return fs
      .readFileSync(path.join(repo, '.git', file), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

const applied = () => readLanes('focus-applied');

function assert(cond, message) {
  if (!cond) {
    throw new Error(`ASSERT: ${message}`);
  }
  console.log(`  ok — ${message}`);
}

async function poll(desc, timeoutMs, fn) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) {
      console.log(`  ok — ${desc} (${Date.now() - t0}ms)`);
      return;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`TIMEOUT after ${timeoutMs}ms: ${desc}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ---- scenarios -----------------------------------------------------------

async function activation() {
  const ext = vscode.extensions.getExtension('local.git-workflow');
  assert(ext, 'extension local.git-workflow is present in the EDH');
  const exported = await ext.activate();
  assert(ext.isActive, 'extension activated');
  api = exported?.test;
  assert(api, 'test hooks exported (GW_TEST_HOOKS)');
}

async function integrationBasics() {
  // Discovery warm-up: keep nudging until the provider knows the lane
  await poll('lane feat/a becomes an integration candidate', 30000, async () => {
    await vscode.commands.executeCommand('worktreeCompare.addToIntegration', {
      worktreePath: laneA,
    });
    return readLanes('focus-candidates').includes('feat/a');
  });
  assert(
    git(repo, ['config', 'branch.integration/main.pushRemote']) === 'no_push',
    'push-block config was applied to the integration branch',
  );

  await vscode.commands.executeCommand('worktreeCompare.applyToIntegration', {
    worktreePath: laneA,
  });
  await poll('integration checkout contains a.txt after apply', 20000, () =>
    fs.existsSync(path.join(working, 'a.txt')),
  );
  assert(applied().includes('feat/a'), 'feat/a is applied');
  assert(
    git(working, ['status', '--porcelain']).length === 0,
    'integration checkout is clean after rebuild',
  );
  assert(
    api.integration()?.lanes.includes('feat/a'),
    'view state: integration panel shows feat/a applied',
  );
}

async function selectionAndPanels() {
  await vscode.commands.executeCommand(
    'worktreeCompare.focusWorktree',
    laneA,
  );
  await poll('view state: selection follows focusWorktree', 10000, () =>
    api.selectedPath() === laneA,
  );
  assert(
    api.worktrees().some((w) => w.path === laneB),
    'view state: discovery lists the second lane',
  );
}

async function wipOverlay() {
  const laneTipBefore = git(repo, ['rev-parse', 'feat/a']);
  fs.writeFileSync(path.join(laneA, 'wip.txt'), 'uncommitted v1\n');
  await vscode.commands.executeCommand(
    'worktreeCompare.includeWipInIntegration',
    { branch: 'feat/a' },
  );
  await poll('integration checkout contains uncommitted wip.txt', 20000, () =>
    fs.existsSync(path.join(working, 'wip.txt')),
  );
  assert(
    git(repo, ['rev-parse', 'feat/a']) === laneTipBefore,
    'lane branch tip is untouched by the wip snapshot',
  );
  assert(
    git(laneA, ['status', '--porcelain']).includes('?? wip.txt'),
    'lane working tree still shows wip.txt as uncommitted',
  );
  assert(
    git(working, ['log', '--format=%s', 'HEAD', '-4']).includes(
      'wip(gw): feat/a',
    ),
    'integration chain contains the ephemeral wip snapshot commit',
  );

  // Event path: an editor save re-rebuilds without any command.
  // WorkspaceEdit (not TextEditor.edit): headless workbenches may have no
  // active editor, and a silently-failed edit must not fake a pass.
  const doc = await vscode.workspace.openTextDocument(
    path.join(laneA, 'wip.txt'),
  );
  const we = new vscode.WorkspaceEdit();
  we.replace(
    doc.uri,
    new vscode.Range(0, 0, doc.lineCount, 0),
    'uncommitted v2 via save\n',
  );
  assert(await vscode.workspace.applyEdit(we), 'workspace edit applied');
  assert(doc.isDirty, 'document is dirty after edit');
  assert(await doc.save(), 'document saved (fires onDidSaveTextDocument)');
  await poll('save in the lane re-rebuilds the integration tree', 30000, () =>
    fs
      .readFileSync(path.join(working, 'wip.txt'), 'utf8')
      .includes('uncommitted v2'),
  );

  await vscode.commands.executeCommand(
    'worktreeCompare.excludeWipFromIntegration',
    { branch: 'feat/a' },
  );
  await poll('wip.txt leaves the integration tree on exclude', 20000, () =>
    !fs.existsSync(path.join(working, 'wip.txt')),
  );

  await vscode.commands.executeCommand('worktreeCompare.hideFromIntegration', {
    worktreePath: laneA,
  });
  await poll('integration checkout resets to base on hide', 20000, () => {
    const head = git(working, ['rev-parse', 'HEAD']);
    const main = git(repo, ['rev-parse', 'main']);
    return head === main && !fs.existsSync(path.join(working, 'a.txt'));
  });
  assert(
    git(repo, ['rev-parse', 'feat/a']) === laneTipBefore,
    'lane branch tip unchanged across the wip session',
  );
}

async function landedLifecycle() {
  // True-merge landing on the "GitHub side"
  git(landing, ['fetch', '-q', 'origin']);
  git(landing, ['merge', '-q', '--no-ff', '-m', 'Merge PR feat/a', 'origin/feat/a']);
  git(landing, ['push', '-q']);
  await vscode.commands.executeCommand('worktreeCompare.rebuildIntegration');
  await vscode.commands.executeCommand('worktreeCompare.applyToIntegration', {
    worktreePath: laneA,
  });
  await poll('true-merged lane retires instead of merging', 20000, () => {
    const tree = git(working, ['rev-parse', 'HEAD^{tree}']);
    const base = git(repo, ['rev-parse', 'origin/main^{tree}']);
    return !applied().includes('feat/a') && tree === base;
  });
  assert(
    readLanes('focus-candidates').includes('feat/a'),
    'retired lane stays listed as a candidate',
  );
  await poll('view state: lane shows landed', 15000, () =>
    (api.integration()?.landed ?? []).includes('feat/a'),
  );

  // Squash landing — content predicate must retire it
  git(landing, ['fetch', '-q', 'origin']);
  git(landing, ['merge', '-q', '--squash', 'origin/feat/b']);
  git(landing, ['commit', '-qm', 'feat b (squash #2)']);
  const squashSha = git(landing, ['rev-parse', 'HEAD']);
  git(landing, ['push', '-q']);
  await vscode.commands.executeCommand('worktreeCompare.rebuildIntegration');
  await vscode.commands.executeCommand('worktreeCompare.applyToIntegration', {
    worktreePath: laneB,
  });
  await poll('squash-landed lane retires by content', 20000, () =>
    !applied().includes('feat/b') &&
    fs.existsSync(path.join(working, 'b.txt')),
  );

  // Revert-safety: reverted squash ⇒ NOT landed ⇒ re-applies as a merge
  git(landing, ['revert', '--no-edit', squashSha]);
  git(landing, ['push', '-q']);
  await vscode.commands.executeCommand('worktreeCompare.rebuildIntegration');
  await poll('revert reaches the integration tree', 20000, () =>
    !fs.existsSync(path.join(working, 'b.txt')),
  );
  await vscode.commands.executeCommand('worktreeCompare.applyToIntegration', {
    worktreePath: laneB,
  });
  await poll('reverted lane re-applies as a real merge', 20000, () =>
    applied().includes('feat/b') &&
    fs.existsSync(path.join(working, 'b.txt')),
  );
}

async function baseBadges() {
  // Advance the remote base past the lanes → 'behind' badge
  fs.writeFileSync(path.join(landing, 'news.txt'), 'base moved\n');
  git(landing, ['add', 'news.txt']);
  git(landing, ['commit', '-qm', 'base advances']);
  git(landing, ['push', '-q']);
  await vscode.commands.executeCommand('worktreeCompare.rebuildIntegration');
  await api.refreshBaseStatuses();
  await poll('view state: lane shows behind-base badge', 15000, async () => {
    await api.refreshBaseStatuses();
    const s = api.baseStatus(laneA);
    return Boolean(s && s.behind >= 1 && !s.conflicts);
  });

  // Conflicting change on the base → 'conflicts' badge (strict probe)
  fs.writeFileSync(path.join(landing, 'a.txt'), 'base disagrees\n');
  git(landing, ['add', 'a.txt']);
  git(landing, ['commit', '-qm', 'base rewrites a.txt']);
  git(landing, ['push', '-q']);
  // feat/a is landed/retired; give it a new commit so it diverges again
  fs.writeFileSync(path.join(laneA, 'a.txt'), 'lane insists\n');
  git(laneA, ['add', 'a.txt']);
  git(laneA, ['commit', '-qm', 'lane edits a.txt']);
  await vscode.commands.executeCommand('worktreeCompare.rebuildIntegration');
  // 30s: this depends on the manual rebuild's base fetch having landed,
  // which can queue behind an in-flight rebuild (observed flaking at 15s)
  await poll('view state: lane shows conflicts-with-base badge', 30000, async () => {
    await api.refreshBaseStatuses();
    return api.baseStatus(laneA)?.conflicts === true;
  });
}

async function manualCatchUp() {
  // Commands that end in a force-push/push OFFER await the notification;
  // headless nothing dismisses it — fire them without awaiting and poll
  // git state instead.
  const fire = (command, arg) =>
    void vscode.commands.executeCommand(command, arg);
  const gitOk = (cwd, args) => {
    try {
      git(cwd, args);
      return true;
    } catch {
      return false;
    }
  };
  const rebasePaused = () => {
    const p = git(laneA, ['rev-parse', '--git-path', 'rebase-merge']);
    return fs.existsSync(path.resolve(laneA, p));
  };

  // laneA still carries the uncommitted wip.txt from the wip scenario —
  // catch-up ops refuse dirty worktrees (as they must), so clean it up
  fs.rmSync(path.join(laneA, 'wip.txt'), { force: true });

  // 1. Conflicted rebase pauses visibly; Abort restores the tip
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

  // 2. Conflicted rebase → Continue refuses on markers → resolve → done
  fire('worktreeCompare.rebaseOntoBase', { worktreePath: laneA });
  await poll('rebase pauses again for the continue flow', 20000, () =>
    rebasePaused(),
  );
  fire('worktreeCompare.continueRebase', { worktreePath: laneA });
  await new Promise((r) => setTimeout(r, 1500));
  assert(
    rebasePaused(),
    'Continue Rebase refuses while conflict markers remain',
  );
  fs.writeFileSync(path.join(laneA, 'a.txt'), 'lane and base agree\n');
  fire('worktreeCompare.continueRebase', { worktreePath: laneA });
  await poll('continue finishes the rebase onto the base', 20000, () =>
    !rebasePaused() &&
    gitOk(repo, ['merge-base', '--is-ancestor', 'origin/main', 'feat/a']),
  );
  assert(
    git(repo, ['show', 'feat/a:a.txt']).trim() === 'lane and base agree',
    'rebased tip carries the resolved content',
  );

  // 3. Clean catch-up honors catchUpStrategy (explicit rebase, no pause)
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

  // 4. Conflicted MERGE from base → resolve markers → Complete commits it
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
}

async function autoMembership() {
  const candidates = () => api.integration()?.candidates ?? [];

  // A fresh worktree based on main should enroll with NO add command;
  // a lane stacked on feat/c (its base is its parent branch) must not.
  git(repo, ['branch', 'feat/c']);
  git(repo, ['worktree', 'add', '-q', '.worktrees/feat-c', 'feat/c']);
  git(repo, ['branch', 'feat/stack', 'feat/c']);
  git(repo, ['worktree', 'add', '-q', '.worktrees/feat-stack', 'feat/stack']);
  await poll('feat/c auto-enrolls (its base matches)', 30000, async () => {
    await vscode.commands.executeCommand('worktreeCompare.refresh');
    return candidates().includes('feat/c');
  });
  assert(
    !candidates().includes('feat/stack'),
    'stacked lane (based on feat/c) is NOT auto-enrolled',
  );
  assert(
    !readLanes('focus-candidates').includes('feat/c'),
    'auto member is derived, not written to focus-candidates',
  );

  // Remove must be a real exit: the exclusion persists across refreshes
  await vscode.commands.executeCommand(
    'worktreeCompare.removeFromIntegration',
    { branch: 'feat/c' },
  );
  await poll('removed auto member disappears', 20000, () =>
    !candidates().includes('feat/c'),
  );
  assert(
    readLanes('focus-excluded').includes('feat/c'),
    'exclusion persisted to focus-excluded',
  );
  await vscode.commands.executeCommand('worktreeCompare.refresh');
  await new Promise((r) => setTimeout(r, 1500));
  assert(
    !candidates().includes('feat/c'),
    'excluded member stays gone after a refresh',
  );

  // Add to Integration is the way back — it clears the exclusion
  await vscode.commands.executeCommand('worktreeCompare.addToIntegration', {
    worktreePath: path.join(repo, '.worktrees', 'feat-c'),
  });
  await poll('re-added member returns', 20000, () =>
    candidates().includes('feat/c'),
  );
  assert(
    !readLanes('focus-excluded').includes('feat/c'),
    'exclusion cleared on re-add',
  );
}

async function autoRebase() {
  const laneC = path.join(repo, '.worktrees', 'feat-c');
  const gitOk = (cwd, args) => {
    try {
      git(cwd, args);
      return true;
    } catch {
      return false;
    }
  };
  const rebasePaused = () => {
    const p = git(laneC, ['rev-parse', '--git-path', 'rebase-merge']);
    return fs.existsSync(path.resolve(laneC, p));
  };

  // Give feat/c its own commit so catch-up is a real rebase. It is
  // unpushed (no origin/feat/c) — exactly the auto-eligible shape.
  fs.writeFileSync(path.join(laneC, 'c.txt'), 'lane c v1\n');
  git(laneC, ['add', 'c.txt']);
  git(laneC, ['commit', '-qm', 'feat c']);
  const featATip = git(repo, ['rev-parse', 'feat/a']);

  const config = vscode.workspace.getConfiguration('worktreeCompare');
  await config.update(
    'autoRebaseLanes',
    'local-only',
    vscode.ConfigurationTarget.Workspace,
  );
  try {
    await poll('unpushed lane auto-rebases onto the base', 30000, async () => {
      await api.refreshBaseStatuses();
      return gitOk(repo, ['merge-base', '--is-ancestor', 'origin/main', 'feat/c']);
    });
    assert(!rebasePaused(), 'auto attempt left no paused rebase behind');
    assert(
      git(repo, ['show', 'feat/c:c.txt']).trim() === 'lane c v1',
      'auto-rebased tip still carries the lane commit',
    );

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
    assert(
      git(repo, ['rev-parse', 'feat/c']) === cTip,
      'conflicting lane tip is untouched',
    );
    assert(!rebasePaused(), 'no paused rebase after the conflict pass');
    // feat/a is behind now too, but pushed — auto must never rewrite it
    assert(
      git(repo, ['rev-parse', 'feat/a']) === featATip,
      'pushed lane feat/a is never auto-rewritten',
    );
  } finally {
    await config.update(
      'autoRebaseLanes',
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
  }
}

async function run() {
  const scenarios = [
    ['activation', activation],
    ['integration basics', integrationBasics],
    ['selection & panels', selectionAndPanels],
    ['wip overlay', wipOverlay],
    ['landed lifecycle', landedLifecycle],
    ['base badges', baseBadges],
    ['manual catch-up', manualCatchUp],
    ['auto membership', autoMembership],
    ['auto rebase', autoRebase],
  ];
  for (const [name, fn] of scenarios) {
    console.log(`[suite] ▸ ${name}`);
    try {
      await fn();
    } catch (err) {
      // Surface the extension's own log so CI failures are diagnosable
      try {
        const tail = fs
          .readFileSync(api.logFile(), 'utf8')
          .split('\n')
          .slice(-80)
          .join('\n');
        console.log('[suite] extension log tail:\n' + tail);
      } catch {}
      throw err;
    }
  }
  console.log('[suite] all scenarios passed');
}

module.exports = { run };
