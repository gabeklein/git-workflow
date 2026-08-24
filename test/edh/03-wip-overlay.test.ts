import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { git, laneA, poll, repo, run, working } from './helpers';

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
