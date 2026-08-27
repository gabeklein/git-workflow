import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  absorbDirtyEdits,
  absorbStrayCommits,
  addedPathsInCommits,
  checkoutForBranch,
} from '../../src/git/integration/absorb';
import {
  findStrayCommits,
  integrationFingerprint,
} from '../../src/git/integration/status';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Absorbing stray work out of the derived integration tree. The scratch
 * repo mirrors a real rebuild: main, a lane that edits app.txt, and an
 * integration checkout holding both. The property under test throughout is
 * that a transplant carries the STRAY delta and never lane content.
 */
describe('absorb', () => {
  let scratch: ScratchRepo;
  let integ: string;

  const read = (root: string, file: string) =>
    fs.readFileSync(path.join(root, file), 'utf8');

  beforeEach(() => {
    scratch = makeRepo({ withOrigin: true });
    // A lane that rewrites the middle line of app.txt
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/lane']);
    fs.writeFileSync(
      path.join(scratch.repo, 'app.txt'),
      'line1\nLANE\nline3\n',
    );
    git(scratch.repo, ['commit', '-qam', 'lane edits app.txt']);
    git(scratch.repo, ['checkout', '-q', 'main']);
    // The integration checkout: base + the lane merged, exactly as a
    // rebuild leaves it
    integ = path.join(scratch.root, 'integ');
    git(scratch.repo, ['worktree', 'add', '-q', integ, '-b', 'integration/main', 'main']);
    git(integ, ['merge', '-q', '--no-ff', '-m', 'integration/main: feat/lane', 'feat/lane']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  /** Commit stray work directly on the integration checkout. */
  /** The base has a checkout in this fixture — the cherry-pick path. */
  const checkoutTarget = () =>
    ({ kind: 'checkout', path: scratch.repo, branch: 'main' }) as const;

  const strayCommit = (file: string, content: string, subject: string) => {
    fs.writeFileSync(path.join(integ, file), content);
    git(integ, ['add', '-A']);
    git(integ, ['commit', '-qm', subject]);
  };

  describe('findStrayCommits', () => {
    it('sees a commit made on the integration checkout, not the merged lane', async () => {
      strayCommit('stray.txt', 'agent work\n', 'agent commits on integration');
      const strays = await findStrayCommits(integ, 'origin/main');
      expect(strays.map((c) => c.subject)).toEqual([
        'agent commits on integration',
      ]);
    });

    it('a clean integration checkout has none', async () => {
      expect(await findStrayCommits(integ, 'origin/main')).toEqual([]);
    });
  });

  describe('absorbStrayCommits', () => {
    it('replays stray commits onto the target and rewinds integration', async () => {
      strayCommit('stray.txt', 'agent work\n', 'agent commits on integration');
      const result = await absorbStrayCommits(integ, 'origin/main', checkoutTarget());
      expect(result).toMatchObject({ ok: true, commits: 1 });
      // The work is on main...
      expect(read(scratch.repo, 'stray.txt')).toBe('agent work\n');
      expect(git(scratch.repo, ['log', '-1', '--format=%s'])).toBe(
        'agent commits on integration',
      );
      // ...and the lane's edit did NOT ride along
      expect(read(scratch.repo, 'app.txt')).toBe('line1\nline2\nline3\n');
      // ...and integration is back at the base, unblocking the rebuild
      expect(git(integ, ['rev-parse', 'HEAD'])).toBe(
        git(scratch.repo, ['rev-parse', 'origin/main']),
      );
      expect(await findStrayCommits(integ, 'origin/main')).toEqual([]);
    });

    it('records where the commit was absorbed from', async () => {
      strayCommit('trace.txt', 'x\n', 'work that needs a paper trail');
      const strayTip = git(integ, ['rev-parse', 'HEAD']);
      await absorbStrayCommits(integ, 'origin/main', checkoutTarget());
      const body = git(scratch.repo, ['log', '-1', '--format=%B']);
      // Identical provenance to the off-tree path — the two replays must
      // not be tellable apart from the commit they leave behind.
      expect(body).toContain(`(cherry picked from commit ${strayTip})`);
      expect(body).toContain('Absorbed-from: integration/main');
      expect(git(scratch.repo, ['log', '-1', '--format=%s'])).toBe(
        'work that needs a paper trail',
      );
    });

    it('replays several commits oldest-first', async () => {
      strayCommit('a.txt', 'first\n', 'stray one');
      strayCommit('b.txt', 'second\n', 'stray two');
      const result = await absorbStrayCommits(integ, 'origin/main', checkoutTarget());
      expect(result).toMatchObject({ ok: true, commits: 2 });
      expect(
        git(scratch.repo, ['log', '-2', '--format=%s', '--reverse']).split('\n'),
      ).toEqual(['stray one', 'stray two']);
    });

    it('a stray edit to a file the lane also touched still leaves lane content behind', async () => {
      // Append below the lane's line: same file, no overlap
      strayCommit('app.txt', 'line1\nLANE\nline3\nagent appended\n', 'agent appends');
      const result = await absorbStrayCommits(integ, 'origin/main', checkoutTarget());
      expect(result).toMatchObject({ ok: true });
      expect(read(scratch.repo, 'app.txt')).toBe(
        'line1\nline2\nline3\nagent appended\n',
      );
    });

    it('conflict aborts cleanly and leaves BOTH sides untouched', async () => {
      // Rewrite the very line the lane owns — it cannot apply to main
      strayCommit('app.txt', 'line1\nAGENT REWRITES THE LANE LINE\nline3\n', 'agent rewrites');
      const integHead = git(integ, ['rev-parse', 'HEAD']);
      const mainHead = git(scratch.repo, ['rev-parse', 'HEAD']);
      const result = await absorbStrayCommits(integ, 'origin/main', checkoutTarget());
      expect(result).toMatchObject({ ok: false, code: 'conflict' });
      expect(git(scratch.repo, ['rev-parse', 'HEAD'])).toBe(mainHead);
      expect(git(scratch.repo, ['status', '--porcelain'])).toBe('');
      expect(git(integ, ['rev-parse', 'HEAD'])).toBe(integHead);
    });

    // The base checkout usually HAS work in progress; refusing on any dirt
    // at all would make the rescue useless exactly when it is needed.
    it('tolerates unrelated work in progress on the target', async () => {
      strayCommit('stray.txt', 'agent work\n', 'agent commits');
      fs.writeFileSync(path.join(scratch.repo, 'app.txt'), 'user is mid-edit\n');
      const result = await absorbStrayCommits(integ, 'origin/main', checkoutTarget());
      expect(result).toMatchObject({ ok: true, commits: 1 });
      expect(read(scratch.repo, 'app.txt')).toBe('user is mid-edit\n');
      // helpers.git() trims, so the leading unstaged-marker space is gone
      expect(git(scratch.repo, ['status', '--porcelain'])).toBe('M app.txt');
    });

    it('refuses when the target is editing a file the absorb would write', async () => {
      strayCommit('stray.txt', 'agent work\n', 'agent commits');
      fs.writeFileSync(path.join(scratch.repo, 'stray.txt'), 'user got there first\n');
      const result = await absorbStrayCommits(integ, 'origin/main', checkoutTarget());
      expect(result).toMatchObject({
        ok: false,
        code: 'target-dirty',
        files: ['stray.txt'],
      });
      expect(read(scratch.repo, 'stray.txt')).toBe('user got there first\n');
      expect(git(integ, ['log', '-1', '--format=%s'])).toBe('agent commits');
    });

    it('reports nothing to do on a clean integration checkout', async () => {
      expect(
        await absorbStrayCommits(integ, 'origin/main', checkoutTarget()),
      ).toMatchObject({ ok: false, code: 'nothing' });
    });
  });

  describe('a busy target', () => {
    // git takes index.lock for any index write, and the extension is
    // touching the base checkout constantly — rebuilds, status probes. A
    // user who hits Absorb in that window used to get a raw
    // "Unable to create ... index.lock" fatal, reported as a conflict.
    const lock = () => path.join(scratch.repo, '.git', 'index.lock');

    it('waits for a lock that clears, instead of failing', async () => {
      strayCommit('patient.txt', 'x\n', 'absorbed after the wait');
      fs.writeFileSync(lock(), '');
      setTimeout(() => fs.rmSync(lock(), { force: true }), 250);
      const result = await absorbStrayCommits(
        integ,
        'origin/main',
        checkoutTarget(),
      );
      expect(result).toMatchObject({ ok: true, commits: 1 });
      expect(read(scratch.repo, 'patient.txt')).toBe('x\n');
    });

    it('reports a lock that never clears as busy, not as a conflict', async () => {
      strayCommit('blocked.txt', 'x\n', 'never absorbed');
      fs.writeFileSync(lock(), '');
      try {
        const result = await absorbStrayCommits(
          integ,
          'origin/main',
          checkoutTarget(),
        );
        // 'conflict' would send the user hunting for a merge that is not there
        expect(result).toMatchObject({ ok: false, code: 'busy' });
      } finally {
        fs.rmSync(lock(), { force: true });
      }
    });

    it('reports a busy target for uncommitted edits too', async () => {
      fs.writeFileSync(path.join(integ, 'dirty.txt'), 'uncommitted\n');
      fs.writeFileSync(lock(), '');
      try {
        expect(await absorbDirtyEdits(integ, scratch.repo)).toMatchObject({
          ok: false,
          code: 'busy',
        });
      } finally {
        fs.rmSync(lock(), { force: true });
      }
      // ...and the work is still there to retry with
      expect(read(integ, 'dirty.txt')).toBe('uncommitted\n');
    });
  });

  describe('absorbDirtyEdits', () => {
    it('moves uncommitted work to the target, uncommitted, and restores integration', async () => {
      fs.writeFileSync(path.join(integ, 'stray.txt'), 'untracked agent file\n');
      fs.writeFileSync(
        path.join(integ, 'app.txt'),
        'line1\nLANE\nline3\nagent appended\n',
      );
      const result = await absorbDirtyEdits(integ, scratch.repo);
      expect(result).toMatchObject({ ok: true, uncommitted: true });
      // Present in the target as CHANGES, not as a commit
      expect(read(scratch.repo, 'stray.txt')).toBe('untracked agent file\n');
      expect(read(scratch.repo, 'app.txt')).toBe(
        'line1\nline2\nline3\nagent appended\n',
      );
      expect(git(scratch.repo, ['log', '-1', '--format=%s'])).toBe('base');
      // Integration is clean again — including the untracked file
      expect(git(integ, ['status', '--porcelain'])).toBe('');
      expect(fs.existsSync(path.join(integ, 'stray.txt'))).toBe(false);
    });

    it('conflict leaves the integration edits in place to retry', async () => {
      fs.writeFileSync(
        path.join(integ, 'app.txt'),
        'line1\nAGENT REWRITES THE LANE LINE\nline3\n',
      );
      const result = await absorbDirtyEdits(integ, scratch.repo);
      expect(result).toMatchObject({ ok: false, code: 'conflict' });
      expect(read(integ, 'app.txt')).toBe(
        'line1\nAGENT REWRITES THE LANE LINE\nline3\n',
      );
      expect(git(scratch.repo, ['status', '--porcelain'])).toBe('');
    });

    it('a conflict rewinds only the absorbed paths, never the target own work', async () => {
      fs.writeFileSync(
        path.join(integ, 'app.txt'),
        'line1\nAGENT REWRITES THE LANE LINE\nline3\n',
      );
      fs.writeFileSync(path.join(scratch.repo, 'other.txt'), 'user is mid-edit\n');
      const result = await absorbDirtyEdits(integ, scratch.repo);
      expect(result).toMatchObject({ ok: false, code: 'conflict' });
      // app.txt is back to HEAD, other.txt is untouched
      expect(read(scratch.repo, 'app.txt')).toBe('line1\nline2\nline3\n');
      expect(read(scratch.repo, 'other.txt')).toBe('user is mid-edit\n');
      expect(git(scratch.repo, ['status', '--porcelain'])).toBe('?? other.txt');
    });

    it('reports nothing to do when the checkout is clean', async () => {
      expect(await absorbDirtyEdits(integ, scratch.repo)).toMatchObject({
        ok: false,
        code: 'nothing',
      });
    });
  });

  describe('fingerprint stray component', () => {
    const strayCount = async () => {
      const fp = await integrationFingerprint(integ, 'origin/main');
      return fp
        .split('\n')
        .find((l) => l.startsWith('strays\0'))
        ?.split('\0')[1];
    };

    // If this ever read non-zero on a settled tree, every tick would see a
    // changed fingerprint and rebuild forever.
    it('is 0 on a freshly rebuilt tree, so it never re-arms itself', async () => {
      expect(await strayCount()).toBe('0');
    });

    it('counts a stray commit, and returns to 0 once absorbed', async () => {
      strayCommit('stray.txt', 'agent work\n', 'agent commits');
      expect(await strayCount()).toBe('1');
      await absorbStrayCommits(integ, 'origin/main', checkoutTarget());
      expect(await strayCount()).toBe('0');
    });
  });

  /**
   * What protects the base from lane-dependent work: an edit carries the
   * surrounding lines as diff context, so a change written against merged
   * lane content cannot apply to the base. An ADDED file has no context to
   * check — that asymmetry is why added files are not absorbed unattended.
   */
  describe('lane-context safety', () => {
    it('refuses a stray edit that sits on lane content', async () => {
      strayCommit('app.txt', 'line1\nAGENT EDITS THE LANE LINE\nline3\n', 'edit');
      expect(
        await absorbStrayCommits(integ, 'origin/main', checkoutTarget()),
      ).toMatchObject({ ok: false, code: 'conflict' });
    });

    it('refuses a stray edit to a file that exists only on the lane', async () => {
      // lane.txt exists in the merged tree, never on the base
      fs.writeFileSync(path.join(integ, 'lane.txt'), 'lane owns this\n');
      git(integ, ['add', '-A']);
      git(integ, ['commit', '-qm', 'seed lane-only file']);
      await absorbStrayCommits(integ, 'origin/main', checkoutTarget());
      strayCommit('lane.txt', 'agent rewrites lane-only file\n', 'edit lane-only');
      expect(
        await absorbStrayCommits(integ, 'origin/main', checkoutTarget()),
      ).toMatchObject({ ok: false, code: 'conflict' });
    });

    // The gap: nothing on the base contradicts a brand-new file, so it
    // applies whatever its contents depend on. Hence the confirmation gate.
    it('an ADDED file applies cleanly even when its contents need the lane', async () => {
      strayCommit(
        'needs-lane.txt',
        'this text only makes sense with LANE present\n',
        'add a lane-dependent file',
      );
      expect(
        await absorbStrayCommits(integ, 'origin/main', checkoutTarget()),
      ).toMatchObject({ ok: true });
      expect(read(scratch.repo, 'needs-lane.txt')).toContain('LANE');
    });
  });

  describe('addedPathsInCommits', () => {
    it('reports added paths and ignores modifications', async () => {
      strayCommit('brand-new.txt', 'new\n', 'add a file');
      const shas = (await findStrayCommits(integ, 'origin/main')).map(
        (c) => c.sha,
      );
      expect(await addedPathsInCommits(integ, shas)).toEqual(['brand-new.txt']);

      // A modification to an existing file contributes nothing
      strayCommit('brand-new.txt', 'changed\n', 'modify it');
      const shas2 = (await findStrayCommits(integ, 'origin/main')).map(
        (c) => c.sha,
      );
      expect(await addedPathsInCommits(integ, shas2)).toEqual([
        'brand-new.txt',
      ]);
    });

    it('is empty for a commit that only edits existing content', async () => {
      strayCommit('app.txt', 'line1\nLANE\nline3\nappended\n', 'edit only');
      const shas = (await findStrayCommits(integ, 'origin/main')).map(
        (c) => c.sha,
      );
      expect(await addedPathsInCommits(integ, shas)).toEqual([]);
    });
  });

  describe('checkoutForBranch', () => {
    it('finds the worktree holding a branch, and nothing for a bare ref', async () => {
      expect(await checkoutForBranch(scratch.repo, 'main')).toBe(scratch.repo);
      expect(await checkoutForBranch(scratch.repo, 'feat/lane')).toBeUndefined();
    });
  });
});
