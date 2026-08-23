/**
 * Runs INSIDE the Extension Development Host. Drives the extension's real
 * registered commands against the fixture repo and asserts on git state.
 * Any thrown error fails the run.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const repo = process.env.GW_FIXTURE_REPO;
const laneA = path.join(repo, '.worktrees', 'feat-a');
const working = path.join(repo, '.worktrees', 'working');

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

async function run() {
  console.log('[suite] activating extension');
  const ext = vscode.extensions.getExtension('local.git-workflow');
  assert(ext, 'extension local.git-workflow is present in the EDH');
  await ext.activate();
  assert(ext.isActive, 'extension activated');

  // 1. Discovery + integration detection warm-up: keep nudging
  //    Add to Integration until the provider knows the lane worktree.
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

  // 2. Apply the lane → integration tree = main + feat/a
  await vscode.commands.executeCommand('worktreeCompare.applyToIntegration', {
    worktreePath: laneA,
  });
  await poll('integration checkout contains a.txt after apply', 20000, () =>
    fs.existsSync(path.join(working, 'a.txt')),
  );
  assert(readLanes('focus-applied').includes('feat/a'), 'feat/a is applied');
  assert(
    git(working, ['status', '--porcelain']).length === 0,
    'integration checkout is clean after rebuild',
  );

  // 3. Wip overlay: uncommitted lane edit reaches the integration tree
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
    fs.readFileSync(path.join(working, 'wip.txt'), 'utf8') ===
      'uncommitted v1\n',
    'wip content matches the lane working tree',
  );
  assert(
    git(repo, ['rev-parse', 'feat/a']) === laneTipBefore,
    'lane branch tip is untouched by the wip snapshot',
  );
  assert(
    git(laneA, ['status', '--porcelain']).includes('?? wip.txt'),
    'lane working tree still shows wip.txt as uncommitted',
  );
  const headSubjects = git(working, ['log', '--format=%s', 'HEAD', '-4']);
  assert(
    headSubjects.includes('wip(gw): feat/a'),
    'integration chain contains the ephemeral wip snapshot commit',
  );

  // 4. Save-triggered re-rebuild (the event-driven path): edit via the
  //    editor and save — no command invocation.
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

  // 5. Exclude wip → back to committed lane state only
  await vscode.commands.executeCommand(
    'worktreeCompare.excludeWipFromIntegration',
    { branch: 'feat/a' },
  );
  await poll('wip.txt leaves the integration tree on exclude', 20000, () =>
    !fs.existsSync(path.join(working, 'wip.txt')),
  );
  assert(
    fs.existsSync(path.join(working, 'a.txt')),
    'committed lane content remains after wip exclude',
  );

  // 6. Uncheck the lane → integration resets to base
  await vscode.commands.executeCommand('worktreeCompare.hideFromIntegration', {
    worktreePath: laneA,
  });
  await poll('integration checkout resets to base on hide', 20000, () => {
    const head = git(working, ['rev-parse', 'HEAD']);
    const main = git(repo, ['rev-parse', 'main']);
    return head === main && !fs.existsSync(path.join(working, 'a.txt'));
  });
  assert(
    !readLanes('focus-applied').includes('feat/a'),
    'feat/a removed from the applied set',
  );

  // 7. Lane worktree end-state: everything still uncommitted, tip unmoved
  assert(
    git(repo, ['rev-parse', 'feat/a']) === laneTipBefore,
    'lane branch tip unchanged across the whole session',
  );

  // ---- Landed-lane lifecycle against a real remote --------------------
  const landing = process.env.GW_FIXTURE_LANDING;
  const laneB = path.join(repo, '.worktrees', 'feat-b');
  const applied = () => readLanes('focus-applied');

  // 8. True-merge landing: feat/a merges on the "GitHub side"; a manual
  //    rebuild (which fetches) must recognize it and retire on apply.
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
  assert(
    fs.existsSync(path.join(working, 'a.txt')),
    'landed content present via the base itself',
  );

  // 9. Squash landing: feat/b lands as a squash commit (no ancestry) —
  //    the content predicate must retire it.
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

  // 10. Revert-safety: the squash is reverted on the remote — the lane is
  //     NOT landed anymore, so applying it must merge it back in.
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

  console.log('[suite] all assertions passed');
}

module.exports = { run };
