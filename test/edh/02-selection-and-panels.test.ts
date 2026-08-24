import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { getApi, laneA, laneB, poll, type TestApi } from './helpers';

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
