/**
 * The Files panel: an explorer for the FOCUSED worktree — git-driven
 * listing (ignores respected), files open as real editable buffers.
 * Runs early: it only reads lane state and adds/removes its own files.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getApi, laneA, laneB, poll, run, type TestApi } from './helpers';

describe('files panel', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });
  after(async () => {
    // Self-contained: later scenarios need laneA CLEAN (catch-up refuses
    // dirty worktrees) — remove everything this suite created.
    for (const rel of ['notes.md', '.gitignore', 'src', 'node_modules']) {
      fs.rmSync(path.join(laneA, rel), { recursive: true, force: true });
    }
    await run('workbench.action.closeAllEditors');
    await run('worktreeCompare.refreshFiles');
  });

  const rootLabels = async () =>
    (await api.explorerChildren()).map((n) => n.label);

  it('lists the focused worktree and follows selection', async () => {
    await poll('explorer lists the focused lane', 30000, async () => {
      await run('worktreeCompare.focusWorktree', laneA);
      return (await rootLabels()).includes('a.txt');
    });
    await run('worktreeCompare.focusWorktree', laneB);
    await poll('explorer follows selection to the other lane', 15000, async () =>
      (await rootLabels()).includes('b.txt'),
    );
    await run('worktreeCompare.focusWorktree', laneA);
    await poll('and back', 15000, async () =>
      (await rootLabels()).includes('a.txt'),
    );
  });

  it('respects gitignore and descends folders', async () => {
    fs.mkdirSync(path.join(laneA, 'src'), { recursive: true });
    fs.writeFileSync(path.join(laneA, 'src', 'inner.ts'), 'export {};\n');
    fs.mkdirSync(path.join(laneA, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(laneA, 'node_modules', 'dep', 'x.js'), '1\n');
    fs.writeFileSync(path.join(laneA, '.gitignore'), 'node_modules/\n');
    await poll('untracked folder appears; ignored one does not', 15000, async () => {
      await run('worktreeCompare.refreshFiles');
      const labels = await rootLabels();
      return labels.includes('src') && !labels.includes('node_modules');
    });
    const rows = await api.explorerChildren();
    const srcFolder = rows.find((n) => n.label === 'src');
    assert.ok(srcFolder && srcFolder.kind === 'explorerFolder', 'src is a folder row');
    const inner = await api.explorerChildren('src');
    assert.deepEqual(
      inner.map((n) => n.label),
      ['inner.ts'],
      'folder level lists its file',
    );
  });

  it('New File creates inside the worktree and opens it', async () => {
    await run('worktreeCompare.newFileInWorktree', undefined, 'notes.md');
    await poll('created file shows in the listing', 15000, async () =>
      (await rootLabels()).includes('notes.md'),
    );
    assert.ok(
      fs.existsSync(path.join(laneA, 'notes.md')),
      'file exists on disk in the focused worktree',
    );
    assert.equal(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      path.join(laneA, 'notes.md'),
      'new file opened as a real editable buffer',
    );
    // Escaping the worktree is refused
    await run('worktreeCompare.newFileInWorktree', undefined, '../escape.txt');
    assert.ok(
      !fs.existsSync(path.join(laneA, '..', 'escape.txt')),
      'path traversal outside the worktree is refused',
    );
  });
});
