import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ignoredFiles, isWorktreeDirty } from '../../src/git/plumbing';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Ignored files are the blind spot a landed-worktree delete has to respect:
 * the dirty probe reports clean, and `git worktree remove` takes them with
 * the folder. Everything the quick-delete exemption relies on is here.
 */
describe('ignoredFiles', () => {
  let scratch: ScratchRepo;
  let wt: string;

  beforeEach(() => {
    scratch = makeRepo();
    fs.writeFileSync(
      path.join(scratch.repo, '.gitignore'),
      '.env\nnode_modules/\n',
    );
    git(scratch.repo, ['add', '-A']);
    git(scratch.repo, ['commit', '-qm', 'ignore rules']);
    wt = path.join(scratch.root, 'lane');
    git(scratch.repo, ['worktree', 'add', '-q', wt, '-b', 'feat/x']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('reports nothing for a genuinely empty checkout', async () => {
    expect(await ignoredFiles(wt)).toEqual([]);
    expect(await isWorktreeDirty(wt)).toBe(false);
  });

  it('finds ignored files the dirty probe cannot see', async () => {
    fs.writeFileSync(path.join(wt, '.env'), 'SECRET=hunter2\n');
    // The whole reason the exemption needs this probe:
    expect(await isWorktreeDirty(wt)).toBe(false);
    expect(await ignoredFiles(wt)).toEqual(['.env']);
  });

  it('collapses a wholly-ignored directory to one entry', async () => {
    fs.mkdirSync(path.join(wt, 'node_modules'));
    fs.writeFileSync(path.join(wt, 'node_modules', 'dep.js'), 'lib\n');
    expect(await ignoredFiles(wt)).toEqual(['node_modules/']);
  });

  it('does not report untracked files — remove refuses on those by itself', async () => {
    fs.writeFileSync(path.join(wt, 'scratch.txt'), 'not ignored\n');
    expect(await ignoredFiles(wt)).toEqual([]);
    expect(await isWorktreeDirty(wt)).toBe(true);
  });

  // Pins the behaviour that makes the ignored check load-bearing: a plain
  // remove destroys these without complaint.
  it('plain `git worktree remove` deletes ignored files silently', async () => {
    fs.writeFileSync(path.join(wt, '.env'), 'SECRET=hunter2\n');
    expect(await isWorktreeDirty(wt)).toBe(false);
    git(scratch.repo, ['worktree', 'remove', wt]);
    expect(fs.existsSync(path.join(wt, '.env'))).toBe(false);
  });
});
