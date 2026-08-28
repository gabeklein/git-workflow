import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuildPreview } from '../../src/git/preview/engine';
import { addAppliedLane } from '../../src/git/preview/lanes';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * A rebuild ends by resetting its checkout HARD. That is only safe while
 * the checkout still holds the preview branch — and it need not, since
 * preview can be enabled by switching a checkout in place, and the
 * caller's path is captured before the chain is computed.
 */
describe('rebuildPreview branch guard', () => {
  let scratch: ScratchRepo;
  let working: string;

  beforeEach(async () => {
    scratch = makeRepo({ withOrigin: true });
    // A lane with real content, so a rebuild has something to merge
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/lane']);
    fs.writeFileSync(path.join(scratch.repo, 'lane.txt'), 'from the lane\n');
    git(scratch.repo, ['add', '-A']);
    git(scratch.repo, ['commit', '-qm', 'lane work']);
    git(scratch.repo, ['checkout', '-q', 'main']);
    // Preview enabled by switching a checkout IN PLACE, which is the
    // shape that makes this hazardous: the base branch then has no worktree
    // of its own, so popping back to it reuses this very checkout.
    working = scratch.repo;
    git(working, ['checkout', '-q', '-b', 'preview/main', 'main']);
    await addAppliedLane(working, 'feat/lane');
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('rebuilds normally while the checkout holds the preview branch', async () => {
    const result = await rebuildPreview(working, 'origin/main');
    expect(result).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(working, 'lane.txt'))).toBe(true);
  });

  // The live failure this guard exists for: switch the checkout to the base
  // to commit something, and the rebuild that commit triggers would reset
  // the BASE branch onto the preview chain.
  it('refuses to reset a checkout switched to the base branch', async () => {
    git(working, ['checkout', '-q', 'main']);
    const mainBefore = git(scratch.repo, ['rev-parse', 'main']);

    const result = await rebuildPreview(working, 'origin/main');

    expect(result).toMatchObject({ ok: false, code: 'moved' });
    expect(git(scratch.repo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(fs.existsSync(path.join(working, 'lane.txt'))).toBe(false);
  });

  it('refuses on a detached HEAD too', async () => {
    git(working, ['checkout', '-q', '--detach', 'main']);
    const result = await rebuildPreview(working, 'origin/main');
    expect(result).toMatchObject({ ok: false, code: 'moved' });
    expect(result).toHaveProperty('message', expect.stringContaining('detached'));
  });

  it('leaves the lock free after refusing, so the next rebuild can run', async () => {
    git(working, ['checkout', '-q', 'main']);
    expect(await rebuildPreview(working, 'origin/main')).toMatchObject({
      code: 'moved',
    });
    git(working, ['checkout', '-q', 'preview/main']);
    expect(await rebuildPreview(working, 'origin/main')).toMatchObject({
      ok: true,
    });
  });
});
