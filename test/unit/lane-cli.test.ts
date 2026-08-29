import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installLaneCli,
  laneCliPath,
  uninstallLaneCli,
} from '../../src/git/preview/laneCli';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * The headless way into the preview. Every case runs the REAL script — a
 * reimplementation in TypeScript would test the wrong thing, since the
 * whole point is that this works with VS Code closed.
 */
describe('lane CLI', () => {
  let scratch: ScratchRepo;
  let cli: string;

  const state = (file: string) => {
    try {
      return fs
        .readFileSync(path.join(scratch.repo, '.git', file), 'utf8')
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  const run = (...args: string[]) =>
    execFileSync(cli, args, { cwd: scratch.repo, encoding: 'utf8' }).trim();

  const runFails = (...args: string[]): string => {
    try {
      execFileSync(cli, args, { cwd: scratch.repo, encoding: 'utf8' });
      throw new Error('expected a failure');
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      return e.stderr ?? e.message;
    }
  };

  beforeEach(async () => {
    scratch = makeRepo();
    git(scratch.repo, ['branch', 'feat/a']);
    git(scratch.repo, ['branch', 'feat/b']);
    await installLaneCli(scratch.repo);
    cli = await laneCliPath(scratch.repo);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('installs executable, inside .git so it is never committed', () => {
    expect(cli).toBe(path.join(scratch.repo, '.git', 'gw-lane'));
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(cli).mode & 0o111).toBeTruthy();
  });

  it('add puts a branch in the preview', () => {
    expect(run('add', 'feat/a')).toContain('feat/a is in the preview');
    expect(state('focus-applied')).toEqual(['feat/a']);
    expect(state('focus-candidates')).toEqual(['feat/a']);
  });

  it('keeps the order lanes were added — that is the merge order', () => {
    run('add', 'feat/b');
    run('add', 'feat/a');
    expect(state('focus-applied')).toEqual(['feat/b', 'feat/a']);
  });

  it('is idempotent — adding twice does not duplicate', () => {
    run('add', 'feat/a');
    run('add', 'feat/a');
    expect(state('focus-applied')).toEqual(['feat/a']);
  });

  it('remove takes it out AND keeps it out', () => {
    run('add', 'feat/a');
    expect(run('remove', 'feat/a')).toContain('out of the preview');
    expect(state('focus-applied')).toEqual([]);
    expect(state('focus-candidates')).toEqual([]);
    // Without the exclusion, auto-membership would re-add the row
    expect(state('focus-excluded')).toEqual(['feat/a']);
  });

  it('add clears a previous exclusion', () => {
    run('add', 'feat/a');
    run('remove', 'feat/a');
    run('add', 'feat/a');
    expect(state('focus-excluded')).toEqual([]);
    expect(state('focus-applied')).toEqual(['feat/a']);
  });

  it('defaults to the current branch', () => {
    git(scratch.repo, ['checkout', '-q', 'feat/b']);
    run('add');
    expect(state('focus-applied')).toEqual(['feat/b']);
  });

  it('refuses a branch that does not exist', () => {
    expect(runFails('add', 'feat/nope')).toContain('no such branch');
    expect(state('focus-applied')).toEqual([]);
  });

  it('reports status without changing anything', () => {
    run('add', 'feat/a');
    const out = run('status');
    expect(out).toContain('applied:');
    expect(out).toContain('feat/a');
    expect(state('focus-applied')).toEqual(['feat/a']);
  });

  /**
   * The rebuild record. Membership alone told an agent its lane was in the
   * preview; when the rebuild had refused, the tree on disk did not hold
   * it — and nothing headless said so.
   */
  describe('status reports how the preview last built', () => {
    const writeRecord = (body: string) =>
      fs.writeFileSync(path.join(scratch.repo, '.git', 'focus-status'), body);

    it('says so plainly when no rebuild has been recorded', () => {
      expect(run('status')).toContain('no rebuild recorded');
    });

    it('leads with the failure, not the membership list', () => {
      writeRecord(
        [
          '# generated',
          'state: failed',
          'code: conflict',
          'lane: feat/a',
          'tree: feat/b',
          'tree-current: no',
          'next: catch feat/a up with origin/main, then rebuild',
          '',
        ].join('\n'),
      );
      const out = run('status');
      expect(out).toContain('last rebuild:');
      expect(out).toContain('code: conflict');
      expect(out).toContain('tree-current: no');
      // Comments are scaffolding for whoever opens the file, not output
      expect(out).not.toContain('# generated');
      expect(out.indexOf('last rebuild:')).toBeLessThan(out.indexOf('applied:'));
    });

    it('warns when a recorded lane has moved since — the failure may be dealt with', () => {
      const stale = 'f'.repeat(40);
      writeRecord(`state: failed\ncode: conflict\nlane: feat/a\ntip: feat/a ${stale}\n`);
      expect(run('status')).toContain('moved since this rebuild ran — feat/a');
    });

    it('stays quiet when every recorded tip is still current', () => {
      const tip = execFileSync('git', ['rev-parse', 'feat/a'], {
        cwd: scratch.repo,
        encoding: 'utf8',
      }).trim();
      writeRecord(`state: ok\ntree: feat/a\ntip: feat/a ${tip}\n`);
      expect(run('status')).not.toContain('moved since');
    });
  });

  it('waits for the rebuild lock rather than corrupting state', async () => {
    // Hold the lock the rebuild uses, then release it mid-wait. Async on
    // purpose: execFileSync blocks the event loop, so a timer could never
    // fire to release it and the test would only prove the timeout works.
    const lock = path.join(scratch.repo, '.git', 'focus-working.lock');
    fs.mkdirSync(lock);
    const done = new Promise<void>((resolve, reject) => {
      execFile(cli, ['add', 'feat/a'], { cwd: scratch.repo }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    await new Promise((r) => setTimeout(r, 400));
    fs.rmdirSync(lock);
    await done;
    expect(state('focus-applied')).toEqual(['feat/a']);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('uninstall removes it, and leaves a foreign file alone', async () => {
    await uninstallLaneCli(scratch.repo);
    expect(fs.existsSync(cli)).toBe(false);
    const theirs = '#!/bin/sh\necho mine\n';
    fs.writeFileSync(cli, theirs);
    await uninstallLaneCli(scratch.repo);
    expect(fs.readFileSync(cli, 'utf8')).toBe(theirs);
  });
});
