import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TipWatch } from '../../src/git/tipWatch';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * What lets Focus follow commits without a refresh: the .git watcher says
 * something moved, and TipWatch says whether it was what Focus shows.
 */
let r: ScratchRepo;
beforeEach(() => {
  r = makeRepo();
});
afterEach(() => r.cleanup());

function commit(file: string): void {
  fs.writeFileSync(path.join(r.repo, file), `${file}\n`);
  git(r.repo, ['add', '-A']);
  git(r.repo, ['commit', '-qm', file]);
}

describe('TipWatch', () => {
  it('counts first sight as moved, then only a real move', async () => {
    const w = new TipWatch();
    expect(await w.moved('k', r.repo, ['HEAD'])).toBe(true);
    expect(await w.moved('k', r.repo, ['HEAD'])).toBe(false);
    commit('a.txt');
    expect(await w.moved('k', r.repo, ['HEAD'])).toBe(true);
    expect(await w.moved('k', r.repo, ['HEAD'])).toBe(false);
  });

  it('a move in any one of several refs counts', async () => {
    git(r.repo, ['branch', 'feat/a']);
    git(r.repo, ['branch', 'feat/b']);
    const w = new TipWatch();
    await w.moved('combo', r.repo, ['feat/a', 'feat/b']);
    git(r.repo, ['checkout', '-q', 'feat/b']);
    commit('b.txt');
    expect(await w.moved('combo', r.repo, ['feat/a', 'feat/b'])).toBe(true);
  });

  it('keys are independent, and an unresolvable ref counts as moved', async () => {
    const w = new TipWatch();
    await w.moved('x', r.repo, ['HEAD']);
    expect(await w.moved('y', r.repo, ['HEAD'])).toBe(true);
    expect(await w.moved('x', r.repo, ['no-such-branch'])).toBe(true);
    // ...and stays "moved" until it resolves again, not silently remembered
    expect(await w.moved('x', r.repo, ['no-such-branch'])).toBe(true);
  });

  it('forget makes the next look count as first sight', async () => {
    const w = new TipWatch();
    await w.moved('k', r.repo, ['HEAD']);
    w.forget('k');
    expect(await w.moved('k', r.repo, ['HEAD'])).toBe(true);
  });
});
