import { describe, expect, it } from 'vitest';
import { folderAutoExpands } from '../../src/views/paths';

/**
 * Full Diff tree layout: a folder starts open when it has at most N direct
 * children (subfolders + files), so small folders do not cost a click.
 */
describe('folderAutoExpands', () => {
  const files = [
    'README.md',
    'src/a.ts',
    'src/b.ts',
    'src/views/x.ts',
    'src/views/y.ts',
    'src/views/z.ts',
    'deep/one/two/leaf.ts',
  ].map((path) => ({ path }));

  it('counts subfolders and files together against the limit', () => {
    // src: a.ts, b.ts, views/ → 3
    expect(folderAutoExpands(files, 'src', 3)).toBe(true);
    expect(folderAutoExpands(files, 'src', 2)).toBe(false);
  });

  it('counts only direct children, not everything beneath', () => {
    // src holds 5 files in all, but only 3 rows at its own level
    expect(folderAutoExpands(files, 'src', 4)).toBe(true);
  });

  it('opens a chain of single-child folders all the way down', () => {
    for (const p of ['deep', 'deep/one', 'deep/one/two']) {
      expect(folderAutoExpands(files, p, 1)).toBe(true);
    }
  });

  it('is off at 0 (and for nonsense limits)', () => {
    expect(folderAutoExpands(files, 'deep', 0)).toBe(false);
    expect(folderAutoExpands(files, 'deep', -1)).toBe(false);
    expect(folderAutoExpands(files, 'deep', Number.NaN)).toBe(false);
  });

  it('does not match a sibling that merely shares a prefix', () => {
    const tricky = ['src/a.ts', 'src-gen/b.ts', 'src-gen/c.ts'].map(
      (path) => ({ path }),
    );
    // `src` has one child; src-gen's two must not leak in
    expect(folderAutoExpands(tricky, 'src', 1)).toBe(true);
  });

  it('at the default of 9, a folder with fewer than 10 entries opens', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ path: `pkg/f${i}.ts` }));
    expect(folderAutoExpands(many(9), 'pkg', 9)).toBe(true);
    expect(folderAutoExpands(many(10), 'pkg', 9)).toBe(false);
  });
});
