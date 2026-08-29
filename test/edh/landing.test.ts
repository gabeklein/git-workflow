/**
 * What happens as PRs land and the base moves: the landed predicate
 * (true-merge, squash, revert-safety) and the lane-vs-base badges.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  applied,
  getApi,
  git,
  landing,
  laneA,
  laneB,
  poll,
  readLanes,
  repo,
  run,
  previewRoot,
  type TestApi,
} from './helpers';

describe('landed lifecycle', () => {
  let api: TestApi;
  let squashSha: string;
  before(async () => {
    api = await getApi();
  });

  it('retires a true-merged lane instead of merging it', async () => {
    // True-merge landing on the "GitHub side"
    git(landing, ['fetch', '-q', 'origin']);
    git(landing, ['merge', '-q', '--no-ff', '-m', 'Merge PR feat/a', 'origin/feat/a']);
    git(landing, ['push', '-q']);
    await run('worktreeCompare.rebuildPreview');
    await run('worktreeCompare.applyToPreview', { worktreePath: laneA });
    await poll('true-merged lane retires instead of merging', 20000, () => {
      const tree = git(previewRoot, ['rev-parse', 'HEAD^{tree}']);
      const base = git(repo, ['rev-parse', 'origin/main^{tree}']);
      return !applied().includes('feat/a') && tree === base;
    });
    assert.ok(
      readLanes('focus-candidates').includes('feat/a'),
      'retired lane stays listed as a candidate',
    );
    await poll('view state: lane shows landed', 15000, () =>
      (api.preview()?.landed ?? []).includes('feat/a'),
    );
  });

  it('retires a squash-landed lane by content', async () => {
    git(landing, ['fetch', '-q', 'origin']);
    git(landing, ['merge', '-q', '--squash', 'origin/feat/b']);
    git(landing, ['commit', '-qm', 'feat b (squash #2)']);
    squashSha = git(landing, ['rev-parse', 'HEAD']);
    git(landing, ['push', '-q']);
    await run('worktreeCompare.rebuildPreview');
    await run('worktreeCompare.applyToPreview', { worktreePath: laneB });
    await poll('squash-landed lane retires by content', 20000, () =>
      !applied().includes('feat/b') &&
      fs.existsSync(path.join(previewRoot, 'b.txt')),
    );
  });

  it('re-applies a reverted squash as a real merge (revert-safety)', async () => {
    git(landing, ['revert', '--no-edit', squashSha]);
    git(landing, ['push', '-q']);
    await run('worktreeCompare.rebuildPreview');
    await poll('revert reaches the preview tree', 20000, () =>
      !fs.existsSync(path.join(previewRoot, 'b.txt')),
    );
    await run('worktreeCompare.applyToPreview', { worktreePath: laneB });
    await poll('reverted lane re-applies as a real merge', 20000, () =>
      applied().includes('feat/b') &&
      fs.existsSync(path.join(previewRoot, 'b.txt')),
    );
  });
});

describe('base badges', () => {
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  it('shows behind-base when the remote base advances past the lane', async () => {
    fs.writeFileSync(path.join(landing, 'news.txt'), 'base moved\n');
    git(landing, ['add', 'news.txt']);
    git(landing, ['commit', '-qm', 'base advances']);
    git(landing, ['push', '-q']);
    await run('worktreeCompare.rebuildPreview');
    await api.refreshBaseStatuses();
    await poll('view state: lane shows behind-base badge', 15000, async () => {
      await api.refreshBaseStatuses();
      const s = api.baseStatus(laneA);
      return Boolean(s && s.behind >= 1 && !s.conflicts);
    });
  });

  it('shows conflicts-with-base on a conflicting base change (strict probe)', async () => {
    fs.writeFileSync(path.join(landing, 'a.txt'), 'base disagrees\n');
    git(landing, ['add', 'a.txt']);
    git(landing, ['commit', '-qm', 'base rewrites a.txt']);
    git(landing, ['push', '-q']);
    // feat/a is landed/retired; give it a new commit so it diverges again
    fs.writeFileSync(path.join(laneA, 'a.txt'), 'lane insists\n');
    git(laneA, ['add', 'a.txt']);
    git(laneA, ['commit', '-qm', 'lane edits a.txt']);
    await run('worktreeCompare.rebuildPreview');
    // 30s: this depends on the manual rebuild's base fetch having landed,
    // which can queue behind an in-flight rebuild (observed flaking at 15s)
    await poll('view state: lane shows conflicts-with-base badge', 30000, async () => {
      await api.refreshBaseStatuses();
      return api.baseStatus(laneA)?.conflicts === true;
    });
  });
});

/**
 * Deleting a landed worktree skips the confirmation modal. Testable end to
 * end precisely because the quick path never reaches a dialog — the
 * fallback flow (dirty, locked, ignored files) does, and stays out of the
 * EDH by design.
 */
/**
 * The landed sweep: a checkout whose branch is in the base is disk with
 * nothing on it, so it goes on its own — and one that cannot go says why,
 * from under Working, where "there is a folder" is what the group means.
 */
describe('landed checkouts clear themselves', () => {
  const sweptPath = path.join(repo, '.worktrees', 'feat-swept');
  const heldPath = path.join(repo, '.worktrees', 'feat-held');
  const derivedPath = path.join(repo, '.worktrees', 'feat-derived');
  const copiedPath = path.join(repo, '.worktrees', 'feat-copied');
  const excludeFile = path.join(repo, '.git', 'info', 'exclude');
  let excludeBefore = '';
  let api: TestApi;
  const config = () => vscode.workspace.getConfiguration('worktreeCompare');

  before(async () => {
    api = await getApi();
    // The fixture turns the sweep off (it would clear the suite's own
    // landed lanes); this is the scenario it belongs to, so switch it on.
    await config().update(
      'autoRemoveLandedWorktrees',
      true,
      vscode.ConfigurationTarget.Workspace,
    );
    // Shared across every worktree, and restored after — later scenarios
    // in this sequential suite must not inherit an ignore rule.
    excludeBefore = fs.existsSync(excludeFile)
      ? fs.readFileSync(excludeFile, 'utf8')
      : '';
  });

  /** Landed by CONTENT: an empty commit leaves the base tree unchanged. */
  const makeLanded = (branch: string, dir: string) => {
    git(repo, ['worktree', 'add', '-q', dir, '-b', branch, 'origin/main']);
    git(dir, ['commit', '-q', '--allow-empty', '-m', `${branch}: no-op work`]);
  };

  after(async () => {
    // Off again before the next scenario inherits it
    await config().update(
      'autoRemoveLandedWorktrees',
      false,
      vscode.ConfigurationTarget.Workspace,
    );
    fs.writeFileSync(excludeFile, excludeBefore);
    fs.rmSync(path.join(repo, '.env'), { force: true });
    for (const d of [sweptPath, heldPath, derivedPath, copiedPath]) {
      if (fs.existsSync(d)) git(repo, ['worktree', 'remove', '--force', d]);
    }
    for (const b of [
      'feat/swept',
      'feat/held',
      'feat/derived',
      'feat/copied',
    ]) {
      try {
        git(repo, ['branch', '-D', b]);
      } catch {
        // the sweep may already have taken the checkout; the ref is ours
      }
    }
  });

  it('removes the folder with nobody asking, and keeps the ref', async () => {
    makeLanded('feat/swept', sweptPath);
    await poll('the landed checkout is swept away', 60000, async () => {
      await run('worktreeCompare.refresh');
      return !fs.existsSync(sweptPath);
    });
    assert.ok(
      git(repo, ['rev-parse', '-q', '--verify', 'refs/heads/feat/swept']),
      'the branch ref is kept — refs are Prune Landed Branches business',
    );
  });

  it('sweeps one whose only ignored files are derived', async () => {
    // The reason this exists: a repo that installs per worktree has a
    // node_modules in every lane, so "any ignored file keeps the folder"
    // kept every landed folder forever. Derived files are not what that
    // rule protects.
    makeLanded('feat/derived', derivedPath);
    fs.appendFileSync(excludeFile, 'node_modules/\n');
    fs.mkdirSync(path.join(derivedPath, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(derivedPath, 'node_modules', 'x.js'), '');
    assert.equal(
      git(derivedPath, ['status', '--porcelain']).trim(),
      '',
      'precondition: the install is ignored, so the checkout reads clean',
    );
    await poll(
      'the landed checkout is swept, node_modules and all',
      60000,
      async () => {
        await run('worktreeCompare.refresh');
        return !fs.existsSync(derivedPath);
      },
    );
  });

  it('sweeps one whose ignored file the root checkout has too', async () => {
    // No pattern could ever cover this one — a .env is exactly what the
    // ignored-files rule protects. What clears it is evidence rather than
    // policy: the same bytes are in the root, which is not going anywhere.
    makeLanded('feat/copied', copiedPath);
    fs.appendFileSync(excludeFile, '.env\n');
    fs.writeFileSync(path.join(repo, '.env'), 'API_KEY=abc\n');
    fs.writeFileSync(path.join(copiedPath, '.env'), 'API_KEY=abc\n');
    assert.equal(
      git(copiedPath, ['status', '--porcelain']).trim(),
      '',
      'precondition: the copy is ignored, so the checkout reads clean',
    );
    await poll('the landed checkout with a copied .env goes', 60000, async () => {
      await run('worktreeCompare.refresh');
      return !fs.existsSync(copiedPath);
    });
    assert.ok(
      fs.existsSync(path.join(repo, '.env')),
      "the root's copy — the reason it was safe — is untouched",
    );
  });

  it('keeps a dirty one, under Working, saying why', async () => {
    makeLanded('feat/held', heldPath);
    fs.writeFileSync(path.join(heldPath, 'unfinished.txt'), 'mid-thought\n');
    const row = async () =>
      (await api.focusRows('working')).find((r) => r.label === 'feat/held');
    await poll('the held checkout says it landed and why', 60000, async () => {
      await run('worktreeCompare.refresh');
      return Boolean((await row())?.description?.includes('landed'));
    });
    const held = await row();
    assert.ok(held, 'it stays under Working — the folder is still there');
    assert.match(
      held?.description ?? '',
      /landed · uncommitted changes/,
      'the row names the blocker, not just the landing',
    );
    assert.ok(fs.existsSync(heldPath), 'and nothing was removed');
    // It is NOT also a Landed row: one branch, one row.
    assert.ok(
      !(await api.focusRows('landed')).some((r) => r.label === 'feat/held'),
      'a checkout on disk is a Working row, never a Landed ref row',
    );
  });
});

describe('quick delete of a landed worktree', () => {
  const quickPath = path.join(repo, '.worktrees', 'feat-quick');
  let api: TestApi;
  before(async () => {
    api = await getApi();
  });

  const makeLandedWorktree = (branch: string, dir: string) => {
    // Landed by CONTENT: an empty commit leaves the base tree unchanged, so
    // merging the branch into the base would do nothing. Keeps origin/main
    // exactly where it is — later scenarios in this suite are sequential.
    git(repo, ['worktree', 'add', '-q', dir, '-b', branch, 'origin/main']);
    git(dir, ['commit', '-q', '--allow-empty', '-m', `${branch}: no-op work`]);
  };

  after(() => {
    // The branch ref outlives the checkout by design — clear it either way
    for (const d of [quickPath, path.join(repo, '.worktrees', 'feat-quick2')]) {
      if (fs.existsSync(d)) git(repo, ['worktree', 'remove', '--force', d]);
    }
    for (const b of ['feat/quick', 'feat/quick2']) {
      try {
        git(repo, ['branch', '-D', b]);
      } catch {
        // already gone
      }
    }
  });

  it('removes it on sight, with no confirmation', async () => {
    makeLandedWorktree('feat/quick', quickPath);
    await poll('the new worktree is discovered', 30000, async () => {
      await run('worktreeCompare.refresh');
      return api.worktrees().some((w) => w.branch === 'feat/quick');
    });
    // No dialog is dismissed anywhere in this test — if the modal opened,
    // this would hang until the poll gives up.
    await run('worktreeCompare.deleteWorktree', { worktreePath: quickPath });
    await poll('landed worktree is gone', 30000, () => !fs.existsSync(quickPath));
    assert.ok(
      git(repo, ['rev-parse', '-q', '--verify', 'refs/heads/feat/quick']),
      'the branch ref is kept — only the checkout goes',
    );
  });

  it('keeps the confirmed flow when the checkout holds ignored files', async () => {
    makeLandedWorktree('feat/quick2', path.join(repo, '.worktrees', 'feat-quick2'));
    const dir = path.join(repo, '.worktrees', 'feat-quick2');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=hunter2\n');
    await poll('the second worktree is discovered', 30000, async () => {
      await run('worktreeCompare.refresh');
      return api.worktrees().some((w) => w.branch === 'feat/quick2');
    });
    // Fire WITHOUT awaiting: this one does open a modal, which nothing
    // dismisses headlessly. The checkout must survive it.
    void run('worktreeCompare.deleteWorktree', { worktreePath: dir });
    await new Promise((r) => setTimeout(r, 3000));
    assert.ok(
      fs.existsSync(path.join(dir, '.env')),
      'ignored files are never taken without a confirmation',
    );
  });
});
