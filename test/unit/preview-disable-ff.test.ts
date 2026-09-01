import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fastForwardBaseBranch,
  switchAwayFromPreview,
  switchToPreviewBranch,
} from '../../src/git/preview/lifecycle';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Leaving preview mode. The preview builds on origin/<base>, so the LOCAL
 * base branch is untouched for as long as preview is on — switching back
 * to it is where that staleness becomes a working tree that looks like it
 * reverted everything that landed meanwhile.
 */
describe('leaving preview mode fast-forwards the base', () => {
  let scratch: ScratchRepo;

  /** Land a commit on the GitHub side and fetch it, leaving local behind. */
  const land = (file: string, body: string) => {
    git(scratch.landing, ['fetch', '-q', 'origin']);
    git(scratch.landing, ['reset', '-q', '--hard', 'origin/main']);
    fs.writeFileSync(path.join(scratch.landing, file), body);
    git(scratch.landing, ['add', '-A']);
    git(scratch.landing, ['commit', '-qm', `land ${file}`]);
    git(scratch.landing, ['push', '-q']);
    git(scratch.repo, ['fetch', '-q', 'origin']);
  };

  beforeEach(() => {
    scratch = makeRepo({ withOrigin: true });
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('brings back a tree holding the PRs that landed during the session', async () => {
    await switchToPreviewBranch(scratch.repo, 'origin/main', 'preview/main');
    land('fix.txt', 'the landed fix\n');

    const result = await switchAwayFromPreview(
      scratch.repo,
      'main',
      'origin/main',
      'preview/main',
    );

    expect(result.branch).toBe('main');
    expect(result.fastForwarded?.branch).toBe('main');
    expect(git(scratch.repo, ['rev-parse', 'main'])).toBe(
      git(scratch.repo, ['rev-parse', 'origin/main']),
    );
    // The point of the whole exercise: the fix is on disk, not just in a ref
    expect(fs.existsSync(path.join(scratch.repo, 'fix.txt'))).toBe(true);
  });

  it('leaves a base with unpushed commits exactly where it is', async () => {
    // Unpushed work on the base, then a PR lands on top: diverged, and
    // advancing it would be a merge, not a fast-forward.
    fs.writeFileSync(path.join(scratch.repo, 'local.txt'), 'mine\n');
    git(scratch.repo, ['add', '-A']);
    git(scratch.repo, ['commit', '-qm', 'unpushed base work']);
    const before = git(scratch.repo, ['rev-parse', 'main']);
    await switchToPreviewBranch(scratch.repo, 'origin/main', 'preview/main');
    land('fix.txt', 'the landed fix\n');

    const result = await switchAwayFromPreview(
      scratch.repo,
      'main',
      'origin/main',
      'preview/main',
    );

    expect(result.branch).toBe('main');
    expect(result.fastForwarded).toBeUndefined();
    expect(git(scratch.repo, ['rev-parse', 'main'])).toBe(before);
    expect(fs.existsSync(path.join(scratch.repo, 'local.txt'))).toBe(true);
  });

  it('is a no-op when the base is already current', async () => {
    await switchToPreviewBranch(scratch.repo, 'origin/main', 'preview/main');
    const result = await switchAwayFromPreview(
      scratch.repo,
      'main',
      'origin/main',
      'preview/main',
    );
    expect(result.fastForwarded).toBeUndefined();
  });

  it('refuses to move a branch this checkout does not hold', async () => {
    land('fix.txt', 'the landed fix\n');
    const before = git(scratch.repo, ['rev-parse', 'main']);
    // Standing on the preview branch, `main` belongs to no checkout here —
    // and may belong to someone else's. Never move it blind.
    await switchToPreviewBranch(scratch.repo, 'origin/main', 'preview/main');
    expect(await fastForwardBaseBranch(scratch.repo, 'origin/main')).toBeUndefined();
    expect(git(scratch.repo, ['rev-parse', 'main'])).toBe(before);
  });
});
