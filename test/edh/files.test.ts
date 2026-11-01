/**
 * The Directory SECTION of the Changes panel: an explorer for the FOCUSED
 * worktree — git-driven listing (ignores respected), files open as real
 * editable buffers. Read through the Changes provider, so a section that
 * stopped rendering fails here rather than passing on the sub-provider.
 * Runs early: it only reads lane state and adds/removes its own files.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getApi, laneA, laneB, poll, run, type TestApi } from './helpers';

describe('directory section', () => {
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

  it('renders as a section of Changes, not as its own panel', async () => {
    await run('worktreeCompare.focusWorktree', laneA);
    await poll('Changes shows the Directory group', 30000, async () =>
      (await api.changesRows()).some((r) => r.label === 'Directory'),
    );
    const labels = (await api.changesRows()).map((r) => r.label);
    // Directory first, Full Diff last — the two expandable sections
    // bracket the panel, with the actionable rows between them.
    assert.equal(labels[0], 'Directory');
    assert.equal(labels[labels.length - 1], 'Full Diff');
    assert.ok(
      labels.some((l) => l.startsWith('Commits')),
      'the diff half is still there',
    );
  });

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

/**
 * Full Diff in tree layout: small folders start open. Rides here because it
 * is the same panel and the same scratch lane, and cleans up the same way.
 */
describe('full diff tree auto-expand', () => {
  let api: TestApi;
  const config = () => vscode.workspace.getConfiguration('worktreeCompare');
  const scratch = path.join(laneA, 'gw-tree');

  before(async () => {
    api = await getApi();
    // Untracked files are part of Full Diff, so nothing needs committing:
    // `small` has 2 children (opens at the default 8), `big` has 10.
    fs.mkdirSync(path.join(scratch, 'small'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'big'), { recursive: true });
    for (const f of ['s1.txt', 's2.txt']) {
      fs.writeFileSync(path.join(scratch, 'small', f), 'x\n');
    }
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(scratch, 'big', `f${i}.txt`), 'x\n');
    }
    await config().update(
      'squashLayout',
      'tree',
      vscode.ConfigurationTarget.Workspace,
    );
    await run('worktreeCompare.focusWorktree', laneA);
  });

  after(async () => {
    for (const key of ['squashLayout', 'treeAutoExpandMaxChildren']) {
      await config().update(
        key,
        undefined,
        vscode.ConfigurationTarget.Workspace,
      );
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    await run('worktreeCompare.refresh');
  });

  const folder = async (parent: string | undefined, label: string) =>
    (await api.fullDiffRows(parent)).find(
      (r) => r.kind === 'folder' && r.label === label,
    );

  it('opens folders with few children and leaves big ones shut', async () => {
    await poll('Full Diff shows the scratch folder', 30000, async () => {
      await run('worktreeCompare.refresh');
      return !!(await folder(undefined, 'gw-tree'));
    });
    assert.equal((await folder(undefined, 'gw-tree'))?.expanded, true);
    assert.equal((await folder('gw-tree', 'small'))?.expanded, true);
    assert.equal(
      (await folder('gw-tree', 'big'))?.expanded,
      false,
      '10 children is over the default limit of 9',
    );
  });

  it('0 turns it off, under a fresh id so the new state applies', async () => {
    const before = await folder(undefined, 'gw-tree');
    await config().update(
      'treeAutoExpandMaxChildren',
      0,
      vscode.ConfigurationTarget.Workspace,
    );
    await poll('the folder starts collapsed', 15000, async () => {
      const row = await folder(undefined, 'gw-tree');
      return row?.expanded === false;
    });
    const after = await folder(undefined, 'gw-tree');
    // VS Code keeps expansion per id and ignores the initial state of an id
    // it has seen; an unchanged id would render as it was left.
    assert.notEqual(after?.id, before?.id, 'setting change mints a new id');
  });
});
