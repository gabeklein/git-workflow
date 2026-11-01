import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCombined, COMBINED_REF } from '../../src/git/combined';
import { addBranch, git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Several branches merged without a checkout: the result holds every
 * branch's work, is measured from their common ancestor, names the files
 * that clashed, and moves nothing but its own ref.
 */
let r: ScratchRepo;
beforeEach(() => {
  r = makeRepo();
});
afterEach(() => r.cleanup());

const files = (from: string, to: string) =>
  git(r.repo, ['diff', '--name-only', from, to]).split('\n').filter(Boolean).sort();

describe('combined', () => {
  it('merges branches that do not clash, against their merge-base', async () => {
    addBranch(r.repo, 'feat/a', 'a.txt', 'a\n');
    addBranch(r.repo, 'feat/b', 'b.txt', 'b\n');
    addBranch(r.repo, 'feat/c', 'c.txt', 'c\n');
    const heads = git(r.repo, ['for-each-ref', '--format=%(objectname)', 'refs/heads']);

    const c = await buildCombined(r.repo, ['feat/a', 'feat/b', 'feat/c']);
    expect(c.base).toBe(git(r.repo, ['rev-parse', 'main']));
    expect(c.conflicts).toEqual([]);
    expect(files(c.base, c.sha)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(git(r.repo, ['rev-parse', COMBINED_REF])).toBe(c.sha);
    // No branch moved, and nothing was checked out.
    expect(git(r.repo, ['for-each-ref', '--format=%(objectname)', 'refs/heads'])).toBe(heads);
    expect(git(r.repo, ['status', '--porcelain'])).toBe('');
  });

  it('names the files that clash, and still produces a result', async () => {
    addBranch(r.repo, 'feat/a', 'app.txt', 'mine\n');
    addBranch(r.repo, 'feat/b', 'app.txt', 'theirs\n');
    const c = await buildCombined(r.repo, ['feat/a', 'feat/b']);
    expect(c.conflicts).toEqual(['app.txt']);
    expect(git(r.repo, ['show', `${c.sha}:app.txt`])).toContain('<<<<<<<');
  });

  it('measures stacked branches from the bottom of the stack', async () => {
    addBranch(r.repo, 'feat/foo', 'foo.txt', 'foo\n');
    addBranch(r.repo, 'feat/bar', 'bar.txt', 'bar\n', 'feat/foo');
    addBranch(r.repo, 'feat/other', 'other.txt', 'other\n');
    const c = await buildCombined(r.repo, ['feat/bar', 'feat/other']);
    expect(files(c.base, c.sha)).toEqual(['bar.txt', 'foo.txt', 'other.txt']);
  });

  it('refuses fewer than two branches', async () => {
    await expect(buildCombined(r.repo, ['main'])).rejects.toThrow(/two/);
  });
});
