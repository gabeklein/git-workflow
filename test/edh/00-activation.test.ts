import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { getApi } from './helpers';

describe('activation', () => {
  it('activates the extension and exports the test hooks', async () => {
    const ext = vscode.extensions.getExtension('local.git-workflow');
    assert.ok(ext, 'extension local.git-workflow is present in the EDH');
    await getApi();
    assert.ok(ext.isActive, 'extension activated');
  });
});
