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
});
