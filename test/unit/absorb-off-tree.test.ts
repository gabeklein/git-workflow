import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absorbStrayCommits } from '../../src/git/integration/absorb';
import { findStrayCommits } from '../../src/git/integration/status';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Absorbing when the base has NO worktree — the shape you get by enabling
 * integration on a checkout in place, where the base branch is a ref and
 * nothing more. The replay happens off-tree and lands as one guarded
 * update-ref.
 */
describe('absorbStrayCommits onto a ref', () => {
  let scratch: ScratchRepo;

  const target = () => ({ kind: 'ref', branch: 'main' }) as const;
  const read = (ref: string, file: string) =>
    git(scratch.repo, ['show', `${ref}:${file}`]);

  beforeEach(() => {
    scratch = makeRepo({ withOrigin: true });
    // A lane with content, then integration ON THE ROOT CHECKOUT itself —
    // so main exists only as a ref from here on.
    git(scratch.repo, ['checkout', '-q', '-b', 'feat/lane']);
    fs.writeFileSync(path.join(scratch.repo, 'app.txt'), 'line1\nLANE\nline3\n');
    git(scratch.repo, ['commit', '-qam', 'lane rewrites app.txt']);
    git(scratch.repo, ['checkout', '-q', 'main']);
    git(scratch.repo, ['checkout', '-q', '-b', 'integration/main']);
    git(scratch.repo, [
      'merge', '-q', '--no-ff', '-m', 'integration/main: feat/lane', 'feat/lane',
    ]);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  const strayCommit = (file: string, content: string, subject: string) => {
    fs.writeFileSync(path.join(scratch.repo, file), content);
    git(scratch.repo, ['add', '-A']);
    git(scratch.repo, ['commit', '-qm', subject]);
  };

  it('moves the stray onto the base ref with main checked out nowhere', () => {
    // Precondition: this is the setup the checkout path cannot serve
    const worktrees = git(scratch.repo, ['worktree', 'list']);
    expect(worktrees).not.toContain('[main]');
  });

  it('replays a stray commit and advances the ref', async () => {
    const mainBefore = git(scratch.repo, ['rev-parse', 'main']);
    strayCommit('stray.txt', 'agent work\n', 'agent commits on integration');

    const result = await absorbStrayCommits(scratch.repo, 'origin/main', target());

    expect(result).toMatchObject({ ok: true, commits: 1, target: 'main' });
    expect(git(scratch.repo, ['rev-parse', 'main'])).not.toBe(mainBefore);
    expect(read('main', 'stray.txt')).toBe('agent work');
    expect(git(scratch.repo, ['log', '-1', '--format=%s', 'main'])).toBe(
      'agent commits on integration',
    );
  });

  it('carries the stray delta only — lane content stays behind', async () => {
    strayCommit(
      'app.txt',
      'line1\nLANE\nline3\nagent appended\n',
      'agent appends',
    );
    expect(
      await absorbStrayCommits(scratch.repo, 'origin/main', target()),
    ).toMatchObject({ ok: true });
    // The lane's own rewrite of line2 must NOT have ridden along
    expect(read('main', 'app.txt')).toBe('line1\nline2\nline3\nagent appended');
  });

  it('preserves the original authorship', async () => {
    strayCommit('who.txt', 'x\n', 'authored elsewhere');
    git(scratch.repo, [
      'commit', '--amend', '-q', '--no-edit',
      '--author', 'Someone Else <someone@example.com>',
    ]);
    await absorbStrayCommits(scratch.repo, 'origin/main', target());
    expect(git(scratch.repo, ['log', '-1', '--format=%an <%ae>', 'main'])).toBe(
      'Someone Else <someone@example.com>',
    );
  });

  it('records where the commit was absorbed from', async () => {
    strayCommit('trace.txt', 'x\n', 'work that needs a paper trail');
    const strayTip = git(scratch.repo, ['rev-parse', 'HEAD']);
    await absorbStrayCommits(scratch.repo, 'origin/main', target());
    const body = git(scratch.repo, ['log', '-1', '--format=%B', 'main']);
    // The source sha stops resolving as soon as integration rebuilds, so
    // the branch line is the half that still answers the question later.
    expect(body).toContain(`(cherry picked from commit ${strayTip})`);
    expect(body).toContain('Absorbed-from: integration/main');
    expect(git(scratch.repo, ['log', '-1', '--format=%s', 'main'])).toBe(
      'work that needs a paper trail',
    );
  });

  it('replays several commits oldest-first', async () => {
    strayCommit('a.txt', 'first\n', 'stray one');
    strayCommit('b.txt', 'second\n', 'stray two');
    expect(
      await absorbStrayCommits(scratch.repo, 'origin/main', target()),
    ).toMatchObject({ ok: true, commits: 2 });
    expect(
      git(scratch.repo, ['log', '-2', '--format=%s', '--reverse', 'main']).split('\n'),
    ).toEqual(['stray one', 'stray two']);
  });

  it('rewinds the integration branch so the guard clears', async () => {
    strayCommit('stray.txt', 'agent work\n', 'agent commits');
    await absorbStrayCommits(scratch.repo, 'origin/main', target());
    expect(await findStrayCommits(scratch.repo, git(scratch.repo, ['rev-parse', 'origin/main']))).toEqual([]);
  });

  it('a conflicting stray leaves the base ref exactly where it was', async () => {
    const mainBefore = git(scratch.repo, ['rev-parse', 'main']);
    // Rewrites the very line the lane owns — cannot apply to the base
    strayCommit('app.txt', 'line1\nAGENT OWNS THIS NOW\nline3\n', 'agent rewrites');

    const result = await absorbStrayCommits(scratch.repo, 'origin/main', target());

    expect(result).toMatchObject({ ok: false, code: 'conflict' });
    expect(git(scratch.repo, ['rev-parse', 'main'])).toBe(mainBefore);
    // And the work is still on integration, not lost
    expect(git(scratch.repo, ['log', '-1', '--format=%s'])).toBe('agent rewrites');
  });
});
