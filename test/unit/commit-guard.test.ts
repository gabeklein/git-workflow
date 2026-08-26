import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitGuardState,
  guardedBranch,
  installCommitGuard,
  uninstallCommitGuard,
} from '../../src/git/integration/commitGuard';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * The guard has to be right about three things: it refuses commits on the
 * guarded branch, it is invisible everywhere else (hooks are shared by every
 * worktree of the repo), and it never touches a hook someone else wrote.
 */
describe('integration commit guard', () => {
  let scratch: ScratchRepo;
  let hook: string;
  let lane: string;

  beforeEach(() => {
    scratch = makeRepo();
    hook = path.join(scratch.repo, '.git', 'hooks', 'pre-commit');
    lane = path.join(scratch.root, 'lane');
    git(scratch.repo, ['worktree', 'add', '-q', lane, '-b', 'feat/x']);
    git(scratch.repo, ['branch', 'integration/main']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  /** Commit on `cwd`, returning whether git allowed it. */
  function tryCommit(cwd: string, name: string): boolean {
    fs.writeFileSync(path.join(cwd, `${name}.txt`), `${name}\n`);
    git(cwd, ['add', '-A']);
    try {
      git(cwd, ['commit', '-qm', name]);
      return true;
    } catch {
      return false;
    }
  }

  it('installs an executable hook and records the branch', async () => {
    expect(await commitGuardState(scratch.repo)).toBe('none');
    expect(await installCommitGuard(scratch.repo, 'integration/main')).toBe(
      'installed',
    );
    expect(await commitGuardState(scratch.repo)).toBe('ours');
    expect(await guardedBranch(scratch.repo)).toBe('integration/main');
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(hook).mode & 0o111).toBeTruthy();
  });

  it('refuses a commit on the guarded branch', async () => {
    await installCommitGuard(scratch.repo, 'integration/main');
    git(scratch.repo, ['checkout', '-q', 'integration/main']);
    const before = git(scratch.repo, ['rev-parse', 'HEAD']);
    expect(tryCommit(scratch.repo, 'stray')).toBe(false);
    expect(git(scratch.repo, ['rev-parse', 'HEAD'])).toBe(before);
    // The refusal is only safe because the work survives it
    expect(fs.existsSync(path.join(scratch.repo, 'stray.txt'))).toBe(true);
  });

  it('lets --no-verify through — the deliberate case still works', async () => {
    await installCommitGuard(scratch.repo, 'integration/main');
    git(scratch.repo, ['checkout', '-q', 'integration/main']);
    fs.writeFileSync(path.join(scratch.repo, 'meant.txt'), 'meant it\n');
    git(scratch.repo, ['add', '-A']);
    git(scratch.repo, ['commit', '--no-verify', '-qm', 'meant it']);
    expect(git(scratch.repo, ['log', '-1', '--format=%s'])).toBe('meant it');
  });

  it('is inert in every other worktree, though they share the hook', async () => {
    await installCommitGuard(scratch.repo, 'integration/main');
    expect(tryCommit(lane, 'lane-work')).toBe(true);
    expect(tryCommit(scratch.repo, 'main-work')).toBe(true);
  });

  it('is inert on a DETACHED head, guarded branch or not', async () => {
    await installCommitGuard(scratch.repo, 'integration/main');
    git(scratch.repo, ['checkout', '-q', '--detach', 'integration/main']);
    expect(tryCommit(scratch.repo, 'detached')).toBe(true);
  });

  it('re-points at a renamed branch instead of guarding a dead name', async () => {
    await installCommitGuard(scratch.repo, 'integration/main');
    expect(await installCommitGuard(scratch.repo, 'preview/main')).toBe(
      'updated',
    );
    expect(await guardedBranch(scratch.repo)).toBe('preview/main');
    git(scratch.repo, ['checkout', '-q', 'integration/main']);
    expect(tryCommit(scratch.repo, 'no-longer-guarded')).toBe(true);
  });

  it('reports unchanged on a redundant install', async () => {
    await installCommitGuard(scratch.repo, 'integration/main');
    expect(await installCommitGuard(scratch.repo, 'integration/main')).toBe(
      'unchanged',
    );
  });

  it('never replaces a hook it did not write', async () => {
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    const theirs = '#!/bin/sh\nexit 0\n';
    fs.writeFileSync(hook, theirs, { mode: 0o755 });
    expect(await commitGuardState(scratch.repo)).toBe('foreign');
    expect(await installCommitGuard(scratch.repo, 'integration/main')).toBe(
      'foreign',
    );
    expect(fs.readFileSync(hook, 'utf8')).toBe(theirs);
    // ...and leaves it alone on the way out, too
    await uninstallCommitGuard(scratch.repo);
    expect(fs.readFileSync(hook, 'utf8')).toBe(theirs);
  });

  it('uninstall removes our hook and stops refusing', async () => {
    await installCommitGuard(scratch.repo, 'integration/main');
    await uninstallCommitGuard(scratch.repo);
    expect(await commitGuardState(scratch.repo)).toBe('none');
    expect(await guardedBranch(scratch.repo)).toBeUndefined();
    git(scratch.repo, ['checkout', '-q', 'integration/main']);
    expect(tryCommit(scratch.repo, 'after-uninstall')).toBe(true);
  });

  it('is inert if the state file goes but the hook stays', async () => {
    await installCommitGuard(scratch.repo, 'integration/main');
    fs.rmSync(path.join(scratch.repo, '.git', 'focus-guard'));
    git(scratch.repo, ['checkout', '-q', 'integration/main']);
    expect(tryCommit(scratch.repo, 'orphan-hook')).toBe(true);
  });
});
