import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBranches } from '../../src/git/branches';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Sync state comes from `%(upstream:track)` in the ref listing git already
 * runs, so every branch's divergence costs no extra git call.
 *
 * Driven through real git rather than by parsing invented strings — the
 * whole risk here is assuming a format git does not actually emit.
 */
describe('branch sync state', () => {
  let scratch: ScratchRepo;

  const commit = (cwd: string, file: string, msg: string) => {
    fs.writeFileSync(path.join(cwd, file), `${msg}\n`);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-qm', msg]);
  };

  const find = async (name: string) =>
    (await listBranches(scratch.repo)).find((b) => b.name === name);

  beforeEach(() => {
    scratch = makeRepo({ withOrigin: true });
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/x']);
    commit(scratch.repo, 'x.txt', 'one');
    git(scratch.repo, ['push', '-q', '-u', 'origin', 'feat/x']);
    git(scratch.repo, ['checkout', '-q', 'main']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('reports nothing when a branch is level with its upstream', async () => {
    const b = await find('feat/x');
    expect(b?.ahead).toBeUndefined();
    expect(b?.behind).toBeUndefined();
  });

  it('counts commits ahead', async () => {
    git(scratch.repo, ['checkout', '-q', 'feat/x']);
    commit(scratch.repo, 'x.txt', 'two');
    commit(scratch.repo, 'x.txt', 'three');
    git(scratch.repo, ['checkout', '-q', 'main']);
    const b = await find('feat/x');
    expect(b?.ahead).toBe(2);
    expect(b?.behind).toBeUndefined();
  });

  it('counts commits behind', async () => {
    // Land work on origin from the other clone, then notice it
    git(scratch.landing, ['fetch', '-q', 'origin']);
    git(scratch.landing, ['checkout', '-q', '-B', 'feat/x', 'origin/feat/x']);
    commit(scratch.landing, 'x.txt', 'theirs');
    git(scratch.landing, ['push', '-q', 'origin', 'feat/x']);
    git(scratch.repo, ['fetch', '-q', 'origin']);
    const b = await find('feat/x');
    expect(b?.behind).toBe(1);
    expect(b?.ahead).toBeUndefined();
  });

  it('counts both when the branch and its upstream have diverged', async () => {
    git(scratch.repo, ['checkout', '-q', 'feat/x']);
    commit(scratch.repo, 'mine.txt', 'mine');
    git(scratch.repo, ['checkout', '-q', 'main']);
    git(scratch.landing, ['fetch', '-q', 'origin']);
    git(scratch.landing, ['checkout', '-q', '-B', 'feat/x', 'origin/feat/x']);
    commit(scratch.landing, 'theirs.txt', 'theirs');
    git(scratch.landing, ['push', '-q', 'origin', 'feat/x']);
    git(scratch.repo, ['fetch', '-q', 'origin']);
    const b = await find('feat/x');
    expect(b?.ahead).toBe(1);
    expect(b?.behind).toBe(1);
  });

  it('says nothing for a branch with no upstream at all', async () => {
    git(scratch.repo, ['branch', 'feat/unpublished']);
    const b = await find('feat/unpublished');
    // Not "ahead" of anything — it is unpublished, which the row conveys
    // by other means.
    expect(b?.ahead).toBeUndefined();
    expect(b?.behind).toBeUndefined();
  });

  it('survives an upstream that was deleted', async () => {
    git(scratch.repo, ['push', '-q', 'origin', '--delete', 'feat/x']);
    git(scratch.repo, ['fetch', '-q', '--prune', 'origin']);
    const b = await find('feat/x');
    // git says [gone]; a count would be meaningless
    expect(b?.ahead).toBeUndefined();
    expect(b?.behind).toBeUndefined();
  });
});
