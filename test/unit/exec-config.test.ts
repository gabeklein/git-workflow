import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git as run } from '../../src/git/exec';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * The extension's git never starts automatic gc/maintenance: a background
 * fetch that repacks someone's repo races whatever else is running there.
 */
let r: ScratchRepo;
beforeEach(() => {
  r = makeRepo();
});
afterEach(() => r.cleanup());

describe('background git config', () => {
  it('overrides the repo\'s own gc and maintenance settings', async () => {
    git(r.repo, ['config', 'gc.auto', '1']);
    git(r.repo, ['config', 'maintenance.auto', 'true']);
    expect((await run(r.repo, ['config', '--get', 'gc.auto'])).trim()).toBe('0');
    expect((await run(r.repo, ['config', '--get', 'maintenance.auto'])).trim()).toBe('false');
  });

  it('reaches the git a command spawns', async () => {
    // An alias runs as a child process: what a fetch's auto-maintenance is.
    git(r.repo, ['config', 'alias.gcauto', '!git config --get gc.auto']);
    git(r.repo, ['config', 'gc.auto', '1']);
    expect((await run(r.repo, ['gcauto'])).trim()).toBe('0');
  });

  it('leaves the user\'s own git alone', () => {
    git(r.repo, ['config', 'gc.auto', '1']);
    expect(git(r.repo, ['config', '--get', 'gc.auto'])).toBe('1');
  });
});
