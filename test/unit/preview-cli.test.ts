import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeRunnerCommand } from '../../src/cli/runner';
import {
  acquireLaneLock,
  readLockOwner,
  releaseLaneLock,
} from '../../src/git/preview/laneLock';
import { writePreviewSettings } from '../../src/git/preview/settings';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Preview operations run from a shell: no resident process, no queue —
 * one command that takes the lock, does the work, and exits with an answer.
 *
 * Every case runs the REAL bundle through the REAL script, because the
 * whole claim is that an agent's terminal reaches the same engine the
 * sidebar does.
 */
describe('preview CLI', () => {
  let scratch: ScratchRepo;
  let repo: string;
  let common: string;
  let cli: string;
  let bundle: string;

  beforeAll(async () => {
    const esbuild = await import('esbuild');
    bundle = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'gw-op-bundle-')),
      'gw-op.js',
    );
    await esbuild.build({
      entryPoints: [path.resolve('src/cli/main.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      alias: { vscode: path.resolve('src/cli/vscodeShim.ts') },
      logLevel: 'silent',
    });
  }, 60_000);

  const run = (...args: string[]) =>
    execFileSync(cli, args, { cwd: repo, encoding: 'utf8' }).trim();

  const runFails = (...args: string[]): { status: number; out: string } => {
    try {
      execFileSync(cli, args, { cwd: repo, encoding: 'utf8' });
      throw new Error('expected a failure');
    } catch (err) {
      const e = err as { status?: number; stderr?: string; stdout?: string };
      return { status: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  const lines = (file: string) => {
    try {
      return fs
        .readFileSync(path.join(common, file), 'utf8')
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  beforeEach(async () => {
    scratch = makeRepo({ withOrigin: true });
    repo = scratch.repo;
    common = path.join(repo, '.git');
    git(repo, ['checkout', '-q', '-b', 'feat/a']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'from a\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'a']);
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['checkout', '-q', '-b', 'preview/main', 'main']);
    await writePreviewSettings(repo, {
      branch: 'preview/main',
      base: 'origin/main',
      checkout: repo,
    });
    await writeRunnerCommand(common, { node: process.execPath, script: bundle });
    const { installLaneCli, laneCliPath } = await import(
      '../../src/git/preview/laneCli'
    );
    await installLaneCli(repo);
    cli = await laneCliPath(repo);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('applies a lane and rebuilds, in one shell session', () => {
    expect(run('add', 'feat/a')).toContain('feat/a is in the preview');
    expect(lines('focus-applied')).toEqual(['feat/a']);
    expect(run('rebuild')).toContain('rebuilt: feat/a');
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(true);
    // …and the record the sidebar reads is written by the same engine run
    expect(fs.readFileSync(path.join(common, 'focus-status'), 'utf8')).toContain(
      'state: ok',
    );
  });

  it('remove is a real exit, and keeps the lane out', () => {
    run('add', 'feat/a');
    expect(run('remove', 'feat/a')).toContain('out of the preview');
    expect(lines('focus-applied')).toEqual([]);
    expect(lines('focus-excluded')).toEqual(['feat/a']);
  });

  /**
   * Preview off, or an editor that has not recorded its settings: a
   * rebuild aimed at a guessed branch would reset the wrong checkout, so
   * this refuses with 2 — "could not run", never "the preview is broken".
   */
  it('refuses to rebuild a repo whose settings it does not have', () => {
    fs.rmSync(path.join(common, 'focus-config'));
    const { status, out } = runFails('rebuild');
    expect(status).toBe(2);
    expect(out).toContain('no preview settings recorded');
  });

  it('says so, and exits 2, when there is nothing to run', () => {
    fs.rmSync(path.join(common, 'focus-runner'));
    const { status, out } = runFails('rebuild');
    expect(status).toBe(2);
    expect(out).toContain('focus-runner missing');
  });

  /**
   * The bundle is a faster way to reach the same code, not the only way:
   * with no runner recorded, membership still works from the shell alone.
   */
  it('falls back to editing the files when no bundle is available', () => {
    fs.rmSync(path.join(common, 'focus-runner'));
    expect(run('add', 'feat/a')).toContain('feat/a is in the preview');
    expect(lines('focus-applied')).toEqual(['feat/a']);
  });

  describe('the lock says who holds it', () => {
    it('reports a live holder, and clears when released', async () => {
      expect(runFails('owner').out).toContain('nobody is writing the preview');
      expect(await acquireLaneLock(common, 'rebuild')).toBe(true);
      expect(run('owner')).toMatch(/busy: rebuild \(pid \d+/);
      await releaseLaneLock(common);
      expect(runFails('owner').out).toContain('nobody is writing');
    });

    it('records what the holder is doing, not just that it is held', async () => {
      await acquireLaneLock(common, 'lane apply feat/a');
      expect((await readLockOwner(common))?.op).toBe('lane apply feat/a');
      await releaseLaneLock(common);
    });

    /**
     * The crash case: a lock left by a dead process used to wedge the repo
     * with nothing to point at. It is swept — but only on THIS host, since
     * signal 0 says nothing about another machine's process table and
     * guessing wrong means two writers in a checkout about to be reset.
     */
    it('sweeps a dead holder from this host', async () => {
      fs.mkdirSync(path.join(common, 'focus-working.lock'));
      fs.writeFileSync(
        path.join(common, 'focus-working.lock', 'owner'),
        `pid: 999999999\nhost: ${os.hostname()}\nstarted: now\nop: rebuild\n`,
      );
      // Exit 1: a stale lock is not a live writer, and `owner` answers
      // "nobody is holding this" rather than naming a ghost as busy
      expect(runFails('owner').out).toContain('stale lock');
      expect(await acquireLaneLock(common, 'rebuild')).toBe(true);
      await releaseLaneLock(common);
    });

    it('never sweeps another host, and says why it cannot', async () => {
      fs.mkdirSync(path.join(common, 'focus-working.lock'));
      fs.writeFileSync(
        path.join(common, 'focus-working.lock', 'owner'),
        'pid: 999999999\nhost: some-other-machine\nstarted: now\nop: rebuild\n',
      );
      expect(run('owner')).toContain('some-other-machine');
      expect(await acquireLaneLock(common, 'rebuild')).toBe(false);
    });

    it('a busy lock is "could not run" (2), not a failed preview (1)', () => {
      fs.mkdirSync(path.join(common, 'focus-working.lock'));
      fs.writeFileSync(
        path.join(common, 'focus-working.lock', 'owner'),
        `pid: ${process.pid}\nhost: ${os.hostname()}\nstarted: now\nop: rebuild\n`,
      );
      const { status, out } = runFails('rebuild');
      expect(status).toBe(2);
      expect(out).toContain('busy');
    });
  });
  /**
   * Absorb from a terminal.
   *
   * The preview checkout is the only place a hotfix to the base can be
   * WRITTEN while the merged lanes are visible, and absorb is the only
   * move aimed at the base — but until it had a CLI it ran from the
   * sidebar alone, so an agent that hit the commit guard had nowhere to
   * go but `--no-verify`. Every case here runs in the shipped layout:
   * the root switched onto the preview branch in place, which leaves the
   * base with NO worktree, so the transplant lands on the ref.
   */
  describe('absorb', () => {
    /** A commit made directly on the preview checkout. */
    const strayCommit = (file: string, body: string, message: string) => {
      fs.writeFileSync(path.join(repo, file), body);
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', message]);
    };

    it('moves a stray commit onto the base ref, and rewinds the preview', () => {
      run('add', 'feat/a');
      run('rebuild');
      const before = git(repo, ['rev-parse', 'main']).trim();
      strayCommit('app.txt', 'line1\nline2 fixed\nline3\n', 'hotfix');
      expect(run('absorb')).toContain('absorbed 1 commit(s) into main');
      // The base moved, and it carries the fix
      expect(git(repo, ['rev-parse', 'main']).trim()).not.toBe(before);
      expect(git(repo, ['show', 'main:app.txt'])).toContain('line2 fixed');
      // …and the lane's content did NOT ride along: the delta was taken
      // against the merged tree, so a.txt stays on feat/a alone.
      expect(git(repo, ['ls-tree', '--name-only', 'main']).split('\n')).not
        .toContain('a.txt');
      // The preview checkout is back to the derived tree — no stray left
      expect(
        git(repo, ['log', '--oneline', 'main..preview/main']).trim(),
      ).toBe('');
    });

    /**
     * The property that makes absorb usable as a hotfix at all: the delta
     * is taken against the MERGED tree, so a fix written in a file a lane
     * has also edited lands on the base carrying the fix and not the lane.
     */
    it('carries only the stray delta out of a file a lane also touched', () => {
      git(repo, ['checkout', '-q', '-b', 'feat/shared', 'main']);
      fs.writeFileSync(path.join(repo, 'app.txt'), 'lane line\nline2\nline3\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'lane edits app.txt']);
      git(repo, ['checkout', '-q', 'preview/main']);
      run('add', 'feat/shared');
      run('rebuild');
      // Written on top of the MERGED tree, so line1 already reads "lane
      // line" here — only the line3 edit is the stray.
      fs.writeFileSync(path.join(repo, 'app.txt'), 'lane line\nline2\nline3 fixed\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'hotfix on top of the lane']);
      run('absorb');
      const landed = git(repo, ['show', 'main:app.txt']);
      expect(landed).toContain('line3 fixed');
      expect(landed).not.toContain('lane line');
    });

    it('absorbs uncommitted edits when the base has a checkout', () => {
      const baseTree = path.join(scratch.root, 'base-checkout');
      git(repo, ['worktree', 'add', '-q', baseTree, 'main']);
      fs.writeFileSync(path.join(repo, 'hotfix.txt'), 'uncommitted\n');
      expect(run('absorb')).toContain('absorbed uncommitted preview edits');
      // Uncommitted in, uncommitted out — absorbing must not decide the
      // work is finished.
      expect(fs.readFileSync(path.join(baseTree, 'hotfix.txt'), 'utf8')).toBe(
        'uncommitted\n',
      );
      expect(fs.existsSync(path.join(repo, 'hotfix.txt'))).toBe(false);
    });

    /**
     * The shipped layout's real answer, and the one the commit guard's
     * refusal now names: with the base unchecked-out there is nowhere for
     * uncommitted work to land, so the way through is to commit first.
     */
    it('says to commit first when the base has no worktree', () => {
      fs.writeFileSync(path.join(repo, 'hotfix.txt'), 'uncommitted\n');
      const { status, out } = runFails('absorb');
      expect(status).toBe(1);
      expect(out).toContain('no worktree');
      expect(out).toContain('Commit them here');
    });

    it('a clean preview is nothing to do, not a failure', () => {
      expect(run('absorb')).toContain('nothing to absorb');
    });

    /**
     * An ADDED file carries no diff context, so it applies to the base
     * cleanly even when its contents depend on lane code. The editor asks;
     * a terminal has to be told up front.
     */
    it('refuses to absorb an added file behind applied lanes, until told', () => {
      run('add', 'feat/a');
      run('rebuild');
      strayCommit('new.txt', 'depends on the lane\n', 'add a file');

      const { status, out } = runFails('absorb');
      expect(status).toBe(1);
      expect(out).toContain('needs-confirmation');
      expect(out).toContain('new.txt');
      expect(out).toContain('--allow-added');
      // Nothing moved
      expect(git(repo, ['ls-tree', '--name-only', 'main']).split('\n')).not
        .toContain('new.txt');

      expect(run('absorb', '--allow-added')).toContain('absorbed 1 commit(s)');
      expect(git(repo, ['ls-tree', '--name-only', 'main']).split('\n')).toContain(
        'new.txt',
      );
    });

    /** With no lanes merged in, the preview tree IS the base — nothing to
     *  depend on, so an added file needs no ceremony. */
    it('does not ask about an added file when no lane is applied', () => {
      strayCommit('new.txt', 'plain\n', 'add a file');
      expect(run('absorb')).toContain('absorbed 1 commit(s) into main');
    });

    it('refuses without settings, and does not guess a base', () => {
      fs.rmSync(path.join(common, 'focus-config'));
      const { status, out } = runFails('absorb');
      expect(status).toBe(2);
      expect(out).toContain('no preview settings recorded');
    });

    it('rejects an argument it does not understand', () => {
      const { status, out } = runFails('absorb', 'feat/a');
      expect(status).toBe(2);
      expect(out).toContain('usage: gw-lane absorb');
    });
  });
});
