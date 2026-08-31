import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLaneOp } from '../../src/git/preview/laneOp';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * The four membership verbs.
 *
 * They were spelled out twice — in the controller as helper calls, in
 * `gw-lane` as shell editing the same files — and the two that look alike
 * are not: unchecking leaves a lane a candidate, Remove excludes it so
 * auto-membership cannot put the row straight back. These tests pin the
 * distinction that the duplication kept blurring.
 */
describe('lane membership ops', () => {
  let scratch: ScratchRepo;
  let repo: string;

  const lines = (file: string) => {
    try {
      return fs
        .readFileSync(path.join(repo, '.git', file), 'utf8')
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const applied = () => lines('focus-applied');
  const candidates = () => lines('focus-candidates');
  const excluded = () => lines('focus-excluded');

  beforeEach(() => {
    scratch = makeRepo();
    repo = scratch.repo;
    git(repo, ['branch', 'feat/a']);
    git(repo, ['branch', 'feat/b']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('apply puts a lane in the tree and on the list', async () => {
    expect(await runLaneOp(repo, 'apply', 'feat/a')).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(applied()).toEqual(['feat/a']);
    expect(candidates()).toEqual(['feat/a']);
  });

  it('apply is how an excluded lane opts back in', async () => {
    await runLaneOp(repo, 'apply', 'feat/a');
    await runLaneOp(repo, 'remove', 'feat/a');
    expect(excluded()).toEqual(['feat/a']);
    await runLaneOp(repo, 'apply', 'feat/a');
    expect(excluded()).toEqual([]);
    expect(applied()).toEqual(['feat/a']);
  });

  it('unapply is the checkbox: out of the tree, still offered', async () => {
    await runLaneOp(repo, 'apply', 'feat/a');
    await runLaneOp(repo, 'unapply', 'feat/a');
    expect(applied()).toEqual([]);
    expect(candidates()).toEqual(['feat/a']);
    // Crucially NOT excluded — the row stays, one click from coming back
    expect(excluded()).toEqual([]);
  });

  it('remove is a real exit: off the list, and kept off', async () => {
    await runLaneOp(repo, 'apply', 'feat/a');
    await runLaneOp(repo, 'remove', 'feat/a');
    expect(applied()).toEqual([]);
    expect(candidates()).toEqual([]);
    expect(excluded()).toEqual(['feat/a']);
  });

  it('candidate offers a lane without applying it', async () => {
    expect(await runLaneOp(repo, 'candidate', 'feat/b')).toMatchObject({
      ok: true,
    });
    expect(candidates()).toEqual(['feat/b']);
    expect(applied()).toEqual([]);
  });

  it('reports when nothing changed, so a caller can skip the rebuild', async () => {
    await runLaneOp(repo, 'apply', 'feat/a');
    expect(await runLaneOp(repo, 'apply', 'feat/a')).toMatchObject({
      changed: false,
    });
  });

  it('refuses to apply a branch that does not exist', async () => {
    expect(await runLaneOp(repo, 'apply', 'feat/ghost')).toMatchObject({
      ok: false,
      code: 'no-such-branch',
    });
    expect(applied()).toEqual([]);
  });

  /**
   * …but leaving must work for a branch that is already gone: that is
   * exactly when a stale row needs clearing, and refusing would strand it.
   */
  it('lets a deleted branch out', async () => {
    await runLaneOp(repo, 'apply', 'feat/a');
    git(repo, ['branch', '-D', 'feat/a']);
    expect(await runLaneOp(repo, 'remove', 'feat/a')).toMatchObject({ ok: true });
    expect(applied()).toEqual([]);
  });

  it('waits for the rebuild lock, and says so rather than racing it', async () => {
    fs.mkdirSync(path.join(repo, '.git', 'focus-working.lock'));
    // A short wait here only: the real default is a minute, because
    // queuing behind a rebuild is the normal case (see laneLock).
    const result = await runLaneOp(repo, 'apply', 'feat/a', { waitMs: 500 });
    expect(result).toMatchObject({ ok: false, code: 'busy' });
    // The lock is somebody else's; it must still be there
    expect(fs.existsSync(path.join(repo, '.git', 'focus-working.lock'))).toBe(true);
    expect(applied()).toEqual([]);
  }, 20_000);
});
