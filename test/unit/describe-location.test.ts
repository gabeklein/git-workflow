import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeLocation } from '../../src/views/pathFilters';

/**
 * The Directory row says where a checkout is. Worktrees are usually
 * siblings of the open folder, so the relationship is the informative
 * part — an absolute path answers but buries it.
 */
describe('describeLocation', () => {
  const root = path.resolve('/work/repo');

  it('is "." for the workspace root itself', () => {
    expect(describeLocation(root, root)).toBe('.');
  });

  it('is a bare relative path for something nested inside', () => {
    // No `./` — nothing else in the vocabulary looks like a bare relative
    // path, so the prefix only costs width.
    expect(describeLocation(path.join(root, '.worktrees', 'feat-a'), root)).toBe(
      path.join('.worktrees', 'feat-a'),
    );
  });

  it('is ../x for a sibling — the common worktree layout', () => {
    expect(describeLocation(path.resolve('/work/other'), root)).toBe(
      path.join('..', 'other'),
    );
  });

  it('climbs only while climbing is still the shortest way to say it', () => {
    const twoUp = path.resolve('/work-parent/x');
    const deepRoot = path.resolve('/work-parent/a/repo');
    expect(describeLocation(twoUp, deepRoot)).toBe(
      path.join('..', '..', 'x'),
    );
    // Three up is longer than just saying where it is
    const threeUp = path.resolve('/x');
    const deeper = path.resolve('/a/b/c/repo');
    expect(describeLocation(threeUp, deeper)).toBe(threeUp);
  });

  it('falls back to ~ when far from the workspace but under home', () => {
    const inHome = path.join(os.homedir(), 'Projects', 'elsewhere');
    expect(describeLocation(inHome, path.resolve('/somewhere/else'))).toBe(
      `~/${path.join('Projects', 'elsewhere')}`,
    );
  });

  it('is "~" for the home directory itself', () => {
    expect(describeLocation(os.homedir(), path.resolve('/somewhere/else'))).toBe(
      '~',
    );
  });

  it('prefers the workspace anchor over home when both apply', () => {
    const wsRoot = path.join(os.homedir(), 'Projects', 'repo');
    const sibling = path.join(os.homedir(), 'Projects', 'other');
    expect(describeLocation(sibling, wsRoot)).toBe(path.join('..', 'other'));
  });

  it('gives an absolute path when nothing shorter is true', () => {
    const far = path.resolve('/tmp/gw-demo/repo');
    expect(describeLocation(far, path.resolve('/a/b/c/workspace'))).toBe(far);
  });

  it('works with no workspace at all', () => {
    const inHome = path.join(os.homedir(), 'x');
    expect(describeLocation(inHome)).toBe('~/x');
  });
});
