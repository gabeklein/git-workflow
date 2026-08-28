import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverWorktrees } from '../../src/git/discovery';
import { setWorkspaceFolders } from './vscode-stub';
import { addBranch, git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Discovery lists every registered checkout, the workspace root included.
 * The root used to be hidden while clean — but it holds a branch like any
 * other checkout, and hiding it hid whatever was checked out there.
 */
describe('discoverWorktrees', () => {
  let scratch: ScratchRepo | undefined;

  afterEach(() => {
    setWorkspaceFolders();
    scratch?.cleanup();
    scratch = undefined;
  });

  function open(): ScratchRepo {
    scratch = makeRepo();
    setWorkspaceFolders(scratch.repo);
    return scratch;
  }

  it('lists the root checkout when it is clean and off the base branch', async () => {
    const { repo } = open();
    addBranch(repo, 'feat/root-work', 'a.txt', 'a\n');
    git(repo, ['checkout', '-q', 'feat/root-work']);

    const found = await discoverWorktrees();
    const root = found.find((w) => w.isRootCheckout);
    expect(root?.branch).toBe('feat/root-work');
    expect(root?.isDirty).toBe(false);
  });

  it('lists a clean root sitting on the base branch too', async () => {
    const { repo } = open();

    const found = await discoverWorktrees();
    expect(found.map((w) => w.branch)).toEqual(['main']);
    expect(found[0]!.path).toBe(repo);
  });

  it('lists the root even when it is the preview checkout', async () => {
    // Discovery reports folders; the VIEW decides what is a lane. With
    // preview on, the root holds preview/main and lanesPlan filters it out
    // by path — which is what lets this module stop consulting the preview
    // setting at all (it used to, only to keep the root visible).
    const { repo } = open();
    git(repo, ['checkout', '-q', '-b', 'preview/main']);
    const found = await discoverWorktrees();
    expect(found.map((w) => w.branch)).toEqual(['preview/main']);
    expect(found[0]?.isRootCheckout).toBe(true);
  });

  it('lists the root first, ahead of linked worktrees', async () => {
    const { root, repo } = open();
    addBranch(repo, 'feat/linked', 'b.txt', 'b\n');
    git(repo, ['worktree', 'add', '-q', path.join(root, 'wt'), 'feat/linked']);
    fs.writeFileSync(path.join(repo, 'app.txt'), 'dirty\n');

    const found = await discoverWorktrees();
    expect(found.map((w) => w.branch)).toEqual(['main', 'feat/linked']);
    expect(found[0]!.isDirty).toBe(true);
  });
});
