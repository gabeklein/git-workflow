import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuildPreview } from '../../src/git/preview/engine';
import { addAppliedLane, addCandidateLane } from '../../src/git/preview/lanes';
import {
  clearPreviewStatus,
  readPreviewStatus,
} from '../../src/git/preview/statusFile';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * What a rebuild leaves behind for whoever reads the repo next.
 *
 * A failed rebuild never touches the checkout, so the tree on disk is the
 * last GOOD chain — the lane that broke it is missing from it. Nothing on
 * disk used to say so, which is how an agent came to debug against a
 * preview its own work was not in.
 */
describe('preview rebuild record', () => {
  let scratch: ScratchRepo;
  let working: string;

  const record = () => readPreviewStatus(working).then((r) => r ?? '');

  const commitOn = (branch: string, file: string, body: string) => {
    git(working, ['checkout', '-q', branch]);
    fs.writeFileSync(path.join(working, file), body);
    git(working, ['add', '-A']);
    git(working, ['commit', '-qm', `${branch}: ${file}`]);
    git(working, ['checkout', '-q', 'preview/main']);
  };

  beforeEach(async () => {
    scratch = makeRepo({ withOrigin: true });
    working = scratch.repo;
    git(working, ['branch', 'feat/a']);
    git(working, ['branch', 'feat/b']);
    git(working, ['checkout', '-q', '-b', 'preview/main', 'main']);
    commitOn('feat/a', 'a.txt', 'from a\n');
    for (const lane of ['feat/a', 'feat/b']) {
      await addCandidateLane(working, lane);
      await addAppliedLane(working, lane);
    }
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('records a good build, the lanes in the tree, and their tips', async () => {
    expect(await rebuildPreview(working, 'origin/main')).toMatchObject({
      ok: true,
    });
    const out = await record();
    expect(out).toContain('state: ok');
    expect(out).toContain('tree-current: yes');
    expect(out).toContain('tree: feat/a');
    expect(out).toContain('preview: preview/main');
    // The tip is what lets a reader tell a live record from a dealt-with one
    expect(out).toContain(`tip: feat/a ${git(working, ['rev-parse', 'feat/a'])}`);
  });

  it('names the conflicting lane, and says the tree does not include it', async () => {
    // Delete-vs-edit: no content rule can settle it, so the rebuild refuses
    // rather than auto-resolving.
    await rebuildPreview(working, 'origin/main');
    git(working, ['checkout', '-q', 'feat/a']);
    fs.rmSync(path.join(working, 'app.txt'));
    git(working, ['commit', '-qam', 'feat/a: drop app.txt']);
    git(working, ['checkout', '-q', 'preview/main']);
    commitOn('feat/b', 'app.txt', 'line1\nEDITED\nline3\n');

    const result = await rebuildPreview(working, 'origin/main');
    expect(result).toMatchObject({ ok: false, code: 'conflict' });

    const out = await record();
    expect(out).toContain('state: failed');
    expect(out).toContain('code: conflict');
    expect(out).toContain('lane: feat/b');
    expect(out).toContain('app.txt');
    expect(out).toContain('tree-current: no');
    expect(out).toContain('missing-from-tree: feat/b');
    // …and it is not also listed as present: the last good build held an
    // older tip of it, which is exactly the confusion this file exists for
    expect(out).toMatch(/^tree: feat\/a$/m);
    // The actionable half: fix it on the lane, never on the preview branch
    expect(out).toMatch(/next: catch feat\/b up with origin\/main/);
    expect(out).toContain('do NOT resolve this on preview/main');
  });

  it('carries the last good tree forward — a refusal leaves the checkout alone', async () => {
    await rebuildPreview(working, 'origin/main');
    expect(await record()).toContain('tree: feat/a');

    git(working, ['checkout', '-q', 'main']); // the rebuild will refuse: 'moved'
    const result = await rebuildPreview(working, 'origin/main', {
      branch: 'preview/main',
      baseRef: 'origin/main',
    });
    expect(result).toMatchObject({ ok: false, code: 'moved' });

    const out = await record();
    expect(out).toContain('state: failed');
    // Still the lanes the tree on disk actually holds, not the applied list
    expect(out).toContain('tree: feat/a');
    expect(out).toContain('tree-current: no');
  });

  it('flags a lossy auto-resolve — the preview dropped hunks to keep building', async () => {
    // Same-line clash: the resolver settles it toward the incoming lane,
    // so the build succeeds while the preview is quietly not either lane.
    commitOn('feat/a', 'app.txt', 'line1\nFROM A\nline3\n');
    commitOn('feat/b', 'app.txt', 'line1\nFROM B\nline3\n');
    expect(await rebuildPreview(working, 'origin/main')).toMatchObject({
      ok: true,
    });
    const out = await record();
    expect(out).toContain('resolved: feat/b — lane-wins, hunks dropped in app.txt');
    expect(out).toContain('next: the preview dropped clashing hunks');
  });

  it('a busy rebuild never overwrites the outcome that is already recorded', async () => {
    await rebuildPreview(working, 'origin/main');
    const before = await record();
    fs.mkdirSync(path.join(working, '.git', 'focus-working.lock'));
    try {
      expect(await rebuildPreview(working, 'origin/main')).toMatchObject({
        ok: false,
        code: 'busy',
      });
      expect(await record()).toBe(before);
    } finally {
      fs.rmdirSync(path.join(working, '.git', 'focus-working.lock'));
    }
  });

  it('is dropped when preview goes off — a record of a preview that is gone', async () => {
    await rebuildPreview(working, 'origin/main');
    await clearPreviewStatus(working);
    expect(await readPreviewStatus(working)).toBeUndefined();
  });
});
