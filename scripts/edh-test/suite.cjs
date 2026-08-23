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

  // Event path: an editor save re-rebuilds without any command
  const doc = await vscode.workspace.openTextDocument(
    path.join(laneA, 'wip.txt'),
  );
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((b) =>
    b.replace(
      new vscode.Range(0, 0, doc.lineCount, 0),
      'uncommitted v2 via save\n',
    ),
  );
  await doc.save();
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
  await poll('view state: lane shows conflicts-with-base badge', 15000, async () => {
    await api.refreshBaseStatuses();
    return api.baseStatus(laneA)?.conflicts === true;
  });
}

async function run() {
  const scenarios = [
    ['activation', activation],
    ['integration basics', integrationBasics],
    ['selection & panels', selectionAndPanels],
    ['wip overlay', wipOverlay],
    ['landed lifecycle', landedLifecycle],
    ['base badges', baseBadges],
  ];
  for (const [name, fn] of scenarios) {
    console.log(`[suite] ▸ ${name}`);
    await fn();
  }
  console.log('[suite] all scenarios passed');
}

module.exports = { run };
