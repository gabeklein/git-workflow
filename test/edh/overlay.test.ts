/**
 * The focus/working overlay core: activation, candidate enrollment, apply,
 * selection behavior, and the wip (uncommitted edits) overlay.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  applied,
  getApi,
  git,
  laneA,
  laneB,
  poll,
  readLanes,
  repo,
  run,
  working,
  type TestApi,
} from './helpers';

describe('activation', () => {
  it('activates the extension and exports the test hooks', async () => {
    const ext = vscode.extensions.getExtension('local.git-workflow');
    assert.ok(ext, 'extension local.git-workflow is present in the EDH');
    await getApi();
    assert.ok(ext.isActive, 'extension activated');
  });
});

describe('integration basics', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  it('enrolls a lane as a candidate and blocks pushes on the branch', async () => {
    // Discovery warm-up: keep nudging until the provider knows the lane
    await poll('lane feat/a becomes an integration candidate', 30000, async () => {
      await run('worktreeCompare.addToIntegration', { worktreePath: laneA });
      return readLanes('focus-candidates').includes('feat/a');
    });
    assert.equal(
      git(repo, ['config', 'branch.integration/main.pushRemote']),
      'no_push',
      'push-block config was applied to the integration branch',
    );
  });

  it('applies the lane into a clean integration checkout', async () => {
    await run('worktreeCompare.applyToIntegration', { worktreePath: laneA });
    await poll('integration checkout contains a.txt after apply', 20000, () =>
      fs.existsSync(path.join(working, 'a.txt')),
    );
    assert.ok(applied().includes('feat/a'), 'feat/a is applied');
    assert.equal(
      git(working, ['status', '--porcelain']).length,
      0,
      'integration checkout is clean after rebuild',
    );
    assert.ok(
      api.integration()?.lanes.includes('feat/a'),
      'view state: integration panel shows feat/a applied',
    );
  });
});

describe('selection & panels', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  it('selection follows focusWorktree and discovery lists all lanes', async () => {
    await vscode.commands.executeCommand('worktreeCompare.focusWorktree', laneA);
    await poll('view state: selection follows focusWorktree', 10000, () =>
      api.selectedPath() === laneA,
    );
    assert.ok(
      api.worktrees().some((w) => w.path === laneB),
      'view state: discovery lists the second lane',
    );
  });
});

describe('wip overlay', () => {
  let laneTipBefore: string;

  it('overlays uncommitted lane edits as an ephemeral snapshot', async () => {
    laneTipBefore = git(repo, ['rev-parse', 'feat/a']);
    fs.writeFileSync(path.join(laneA, 'wip.txt'), 'uncommitted v1\n');
    await run('worktreeCompare.includeWipInIntegration', { branch: 'feat/a' });
    await poll('integration checkout contains uncommitted wip.txt', 20000, () =>
      fs.existsSync(path.join(working, 'wip.txt')),
    );
    assert.equal(
      git(repo, ['rev-parse', 'feat/a']),
      laneTipBefore,
      'lane branch tip is untouched by the wip snapshot',
    );
    assert.ok(
      git(laneA, ['status', '--porcelain']).includes('?? wip.txt'),
      'lane working tree still shows wip.txt as uncommitted',
    );
    assert.ok(
      git(working, ['log', '--format=%s', 'HEAD', '-4']).includes(
        'wip(gw): feat/a',
      ),
      'integration chain contains the ephemeral wip snapshot commit',
    );
  });

  it('re-rebuilds on an editor save in the lane (event path)', async () => {
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
    assert.ok(await vscode.workspace.applyEdit(we), 'workspace edit applied');
    assert.ok(doc.isDirty, 'document is dirty after edit');
    assert.ok(await doc.save(), 'document saved (fires onDidSaveTextDocument)');
    await poll('save in the lane re-rebuilds the integration tree', 30000, () =>
      fs
        .readFileSync(path.join(working, 'wip.txt'), 'utf8')
        .includes('uncommitted v2'),
    );
  });

  it('exclude drops the wip overlay; hide resets to base', async () => {
    await run('worktreeCompare.excludeWipFromIntegration', { branch: 'feat/a' });
    await poll('wip.txt leaves the integration tree on exclude', 20000, () =>
      !fs.existsSync(path.join(working, 'wip.txt')),
    );

    await run('worktreeCompare.hideFromIntegration', { worktreePath: laneA });
    await poll('integration checkout resets to base on hide', 20000, () => {
      const head = git(working, ['rev-parse', 'HEAD']);
      const main = git(repo, ['rev-parse', 'main']);
      return head === main && !fs.existsSync(path.join(working, 'a.txt'));
    });
    assert.equal(
      git(repo, ['rev-parse', 'feat/a']),
      laneTipBefore,
      'lane branch tip unchanged across the wip session',
    );
  });
});
