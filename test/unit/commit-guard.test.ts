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
 * worktree of the repo), and it never costs anyone the hook they already
 * had — a repo may only have one pre-commit, so ours chains into theirs.
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
    // eslint-disable-next-line no-bitwise
    expect(
      fs.statSync(
        path.join(scratch.repo, '.git', 'hooks', 'git-workflow-integration-guard'),
      ).mode & 0o111,
    ).toBeTruthy();
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

  describe('an existing pre-commit hook', () => {
    /** Someone else's hook: side effect proves it still runs, exit 1 on veto. */
    const theirs = (extra = '') =>
      `#!/bin/sh\n${extra}echo theirs >> "$(git rev-parse --show-toplevel)/ran.log"\n`;

    function writeHook(body: string) {
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, body, { mode: 0o755 });
    }

    const ranLog = () => {
      try {
        return fs.readFileSync(path.join(scratch.repo, 'ran.log'), 'utf8');
      } catch {
        return '';
      }
    };

    it('is chained into, not replaced — and still runs', async () => {
      writeHook(theirs());
      expect(await commitGuardState(scratch.repo)).toBe('foreign');
      expect(await installCommitGuard(scratch.repo, 'integration/main')).toBe(
        'chained',
      );
      expect(await commitGuardState(scratch.repo)).toBe('chained');
      // Their body survived verbatim
      expect(fs.readFileSync(hook, 'utf8')).toContain('echo theirs >>');
      expect(tryCommit(scratch.repo, 'ordinary')).toBe(true);
      expect(ranLog()).toContain('theirs');
    });

    it('refuses on the guarded branch, before their hook does any work', async () => {
      writeHook(theirs());
      await installCommitGuard(scratch.repo, 'integration/main');
      git(scratch.repo, ['checkout', '-q', 'integration/main']);
      expect(tryCommit(scratch.repo, 'stray')).toBe(false);
      // The chain sits above their body — no point running it for a commit
      // that is already rejected.
      expect(ranLog()).toBe('');
    });

    it('keeps their veto working', async () => {
      writeHook(theirs('exit 1\n'));
      await installCommitGuard(scratch.repo, 'integration/main');
      expect(tryCommit(scratch.repo, 'they-say-no')).toBe(false);
    });

    it('goes in below the shebang, so it is still a valid script', async () => {
      writeHook(theirs());
      await installCommitGuard(scratch.repo, 'integration/main');
      const lines = fs.readFileSync(hook, 'utf8').split('\n');
      expect(lines[0]).toBe('#!/bin/sh');
      expect(lines[1]).toContain('git-workflow');
    });

    it('uninstall removes our two lines and nothing else', async () => {
      const body = theirs();
      writeHook(body);
      await installCommitGuard(scratch.repo, 'integration/main');
      await uninstallCommitGuard(scratch.repo);
      expect(fs.readFileSync(hook, 'utf8')).toBe(body);
      expect(await commitGuardState(scratch.repo)).toBe('foreign');
    });

    it('does not chain twice', async () => {
      writeHook(theirs());
      await installCommitGuard(scratch.repo, 'integration/main');
      expect(await installCommitGuard(scratch.repo, 'integration/main')).toBe(
        'unchanged',
      );
      const body = fs.readFileSync(hook, 'utf8');
      expect(body.split('git-workflow: integration commit guard').length - 1).toBe(1);
    });

    it('is left strictly alone when it is NOT a shell script', async () => {
      // Splicing sh into a python hook would break every commit in the repo
      const python = '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n';
      writeHook(python);
      expect(await installCommitGuard(scratch.repo, 'integration/main')).toBe(
        'foreign',
      );
      expect(fs.readFileSync(hook, 'utf8')).toBe(python);
      await uninstallCommitGuard(scratch.repo);
      expect(fs.readFileSync(hook, 'utf8')).toBe(python);
    });

    it('survives a dangling guard script instead of failing every commit', async () => {
      writeHook(theirs());
      await installCommitGuard(scratch.repo, 'integration/main');
      fs.rmSync(
        path.join(scratch.repo, '.git', 'hooks', 'git-workflow-integration-guard'),
      );
      git(scratch.repo, ['checkout', '-q', 'integration/main']);
      expect(tryCommit(scratch.repo, 'guard-gone')).toBe(true);
    });
  });

  it('follows core.hooksPath instead of installing where git will not look', async () => {
    // husky and friends. Writing to .git/hooks here would LOOK installed
    // while never running — worse than not installing at all.
    const custom = path.join(scratch.repo, '.husky');
    fs.mkdirSync(custom, { recursive: true });
    git(scratch.repo, ['config', 'core.hooksPath', '.husky']);
    expect(await installCommitGuard(scratch.repo, 'integration/main')).toBe(
      'installed',
    );
    expect(fs.existsSync(path.join(custom, 'pre-commit'))).toBe(true);
    expect(fs.existsSync(hook)).toBe(false);
    git(scratch.repo, ['checkout', '-q', 'integration/main']);
    expect(tryCommit(scratch.repo, 'stray')).toBe(false);
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
