import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeBlocker,
  landedWorktreeVerdict,
  sweepLandedWorktrees,
  type LandedWorktreeFacts,
} from '../../src/git/landedWorktrees';
import type { DiscoveredWorktree } from '../../src/git/discovery';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Clearing the checkouts of landed branches, and refusing to when the
 * folder holds anything the base does not.
 *
 * The asymmetry under test throughout: a wrongly-kept folder costs disk,
 * a wrongly-removed one costs work. So every probe that cannot run has to
 * come back as a blocker.
 */
const facts = (over: Partial<LandedWorktreeFacts> = {}): LandedWorktreeFacts => ({
  dirty: false,
  ignored: false,
  open: false,
  busy: false,
  locked: false,
  main: false,
  detached: false,
  ...over,
});

describe('landedWorktreeVerdict', () => {
  it('removes a landed checkout with nothing of its own in it', () => {
    expect(landedWorktreeVerdict(facts())).toEqual({ remove: true });
  });

  it.each([
    ['dirty', { dirty: true }],
    ['ignored', { ignored: true }],
    ['open', { open: true }],
    ['busy', { busy: true }],
    ['locked', { locked: true }],
    ['main', { main: true }],
    ['detached', { detached: true }],
  ] as const)('keeps it when %s', (blocker, over) => {
    expect(landedWorktreeVerdict(facts(over))).toEqual({
      remove: false,
      blocker,
    });
  });

  it('reports the most specific blocker when several apply', () => {
    // The row shows one reason; uncommitted work outranks a lock.
    expect(landedWorktreeVerdict(facts({ dirty: true, locked: true }))).toEqual({
      remove: false,
      blocker: 'dirty',
    });
    // And a paused merge outranks the dirtiness it causes: conflict
    // markers ARE uncommitted changes, but "resolve or abort" is the
    // actionable half.
    expect(landedWorktreeVerdict(facts({ dirty: true, busy: true }))).toEqual({
      remove: false,
      blocker: 'busy',
    });
  });

  it('names every blocker in the row text', () => {
    // A blocker with no wording is a row that says nothing — the exact
    // failure this feature exists to fix.
    for (const blocker of [
      'dirty',
      'ignored',
      'open',
      'busy',
      'locked',
      'main',
      'detached',
      'failed',
      'off',
    ] as const) {
      expect(describeBlocker(blocker)).toContain('landed');
    }
  });
});

describe('sweepLandedWorktrees', () => {
  let scratch: ScratchRepo;
  let lane: string;

  const wt = (over: Partial<DiscoveredWorktree> = {}): DiscoveredWorktree =>
    ({
      path: lane,
      name: path.basename(lane),
      branch: 'feat/landed',
      detached: false,
      ...over,
    }) as DiscoveredWorktree;

  const never = () => false;

  /** Commit a .gitignore on main and bring the lane up to it. */
  const ignoreAndCommit = (body: string): void => {
    fs.writeFileSync(path.join(scratch.repo, '.gitignore'), body);
    git(scratch.repo, ['add', '-A']);
    git(scratch.repo, ['commit', '-qm', 'ignore rules']);
    git(lane, ['merge', '-q', '--ff-only', 'main']);
  };

  beforeEach(() => {
    scratch = makeRepo();
    lane = path.join(scratch.root, 'lane');
    git(scratch.repo, ['worktree', 'add', '-q', lane, '-b', 'feat/landed']);
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('removes the folder and keeps the branch ref', async () => {
    const result = await sweepLandedWorktrees(
      [wt()],
      new Set(['feat/landed']),
      { remove: true, isOpen: never },
    );
    expect(result.removed.map((r) => r.branch)).toEqual(['feat/landed']);
    expect(result.blocked.size).toBe(0);
    expect(fs.existsSync(lane)).toBe(false);
    // The ref survives: refs are Prune Landed Branches' business, and this
    // only ever gives back a folder.
    expect(
      git(scratch.repo, ['rev-parse', '--verify', 'refs/heads/feat/landed']),
    ).toBeTruthy();
  });

  it('leaves a branch that has NOT landed completely alone', async () => {
    const result = await sweepLandedWorktrees([wt()], new Set(), {
      remove: true,
      isOpen: never,
    });
    expect(result).toEqual({ removed: [], blocked: new Map() });
    expect(fs.existsSync(lane)).toBe(true);
  });

  it('keeps a dirty checkout and says why', async () => {
    fs.writeFileSync(path.join(lane, 'wip.txt'), 'half an idea\n');
    const result = await sweepLandedWorktrees(
      [wt()],
      new Set(['feat/landed']),
      { remove: true, isOpen: never },
    );
    expect(result.removed).toEqual([]);
    expect(result.blocked.get(lane)).toEqual({
      branch: 'feat/landed',
      blocker: 'dirty',
    });
    expect(fs.existsSync(path.join(lane, 'wip.txt'))).toBe(true);
  });

  it('keeps a checkout holding ignored files — the one thing removal destroys', async () => {
    ignoreAndCommit('.env\n');
    fs.writeFileSync(path.join(lane, '.env'), 'SECRET=hunter2\n');
    // Precondition: invisible to the dirty probe, which is the whole point
    expect(git(lane, ['status', '--porcelain'])).toBe('');

    const result = await sweepLandedWorktrees(
      [wt()],
      new Set(['feat/landed']),
      { remove: true, isOpen: never },
    );
    expect(result.blocked.get(lane)?.blocker).toBe('ignored');
    expect(fs.readFileSync(path.join(lane, '.env'), 'utf8')).toBe(
      'SECRET=hunter2\n',
    );
  });

  it('removes a checkout whose only ignored files are derived', async () => {
    // The case that made this rule fire on every landed lane: a repo that
    // installs per worktree. node_modules is not what the ignored-files
    // guard is protecting, and treating it as such kept every landed
    // folder on disk forever.
    ignoreAndCommit('node_modules/\ndist/\n');
    fs.mkdirSync(path.join(lane, 'node_modules', 'left-pad'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(lane, 'node_modules', 'left-pad', 'i.js'), '');
    fs.mkdirSync(path.join(lane, 'dist'));
    fs.writeFileSync(path.join(lane, 'dist', 'main.js'), 'built\n');
    expect(git(lane, ['status', '--porcelain'])).toBe('');

    const lines: string[] = [];
    const result = await sweepLandedWorktrees(
      [wt()],
      new Set(['feat/landed']),
      { remove: true, isOpen: never, log: (line) => lines.push(line) },
    );
    expect(result.removed.map((r) => r.branch)).toEqual(['feat/landed']);
    expect(fs.existsSync(lane)).toBe(false);
    // Silently is the one way taking them unattended goes wrong.
    expect(lines.join('\n')).toMatch(/also deleted ignored .*node_modules/);
  });

  it('keeps a checkout holding one precious file among derived ones', async () => {
    ignoreAndCommit('node_modules/\n.env\n');
    fs.mkdirSync(path.join(lane, 'node_modules'));
    fs.writeFileSync(path.join(lane, 'node_modules', 'x.js'), '');
    fs.writeFileSync(path.join(lane, '.env'), 'SECRET=hunter2\n');

    const result = await sweepLandedWorktrees(
      [wt()],
      new Set(['feat/landed']),
      { remove: true, isOpen: never },
    );
    expect(result.blocked.get(lane)?.blocker).toBe('ignored');
    expect(fs.existsSync(path.join(lane, '.env'))).toBe(true);
  });

  it('blocks on any ignored file when the expendable list is emptied', async () => {
    ignoreAndCommit('node_modules/\n');
    fs.mkdirSync(path.join(lane, 'node_modules'));
    fs.writeFileSync(path.join(lane, 'node_modules', 'x.js'), '');

    const result = await sweepLandedWorktrees(
      [wt()],
      new Set(['feat/landed']),
      { remove: true, isOpen: never, expendable: [] },
    );
    expect(result.blocked.get(lane)?.blocker).toBe('ignored');
    expect(fs.existsSync(lane)).toBe(true);
  });

  it('keeps a checkout with a file open in an editor', async () => {
    const result = await sweepLandedWorktrees(
      [wt()],
      new Set(['feat/landed']),
      { remove: true, isOpen: (p) => p === lane },
    );
    expect(result.blocked.get(lane)?.blocker).toBe('open');
    expect(fs.existsSync(lane)).toBe(true);
  });

  it('keeps a checkout with a paused merge', async () => {
    // A conflicting merge, left mid-resolution: somebody's work in progress
    fs.writeFileSync(path.join(scratch.repo, 'clash.txt'), 'main side\n');
    git(scratch.repo, ['add', '-A']);
    git(scratch.repo, ['commit', '-qm', 'main writes clash.txt']);
    fs.writeFileSync(path.join(lane, 'clash.txt'), 'lane side\n');
    git(lane, ['add', '-A']);
    git(lane, ['commit', '-qm', 'lane writes clash.txt']);
    try {
      git(lane, ['merge', 'main']);
    } catch {
      // expected: the merge conflicts and stays paused
    }
    expect(git(lane, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBeTruthy();

    const result = await sweepLandedWorktrees(
      [wt()],
      new Set(['feat/landed']),
      { remove: true, isOpen: never },
    );
    expect(result.blocked.get(lane)?.blocker).toBe('busy');
    expect(fs.existsSync(lane)).toBe(true);
  });

  it('never touches the main worktree, landed or not', async () => {
    const result = await sweepLandedWorktrees(
      [wt({ path: scratch.repo, branch: 'main', isMainWorktree: true })],
      new Set(['main']),
      { remove: true, isOpen: never },
    );
    expect(result.blocked.get(scratch.repo)?.blocker).toBe('main');
    expect(fs.existsSync(scratch.repo)).toBe(true);
  });

  it('with removal off, still reports the folder as on disk', async () => {
    // The visibility half is not what the setting turns off: a landed
    // checkout nobody can see is the bug, not the cleanup.
    const result = await sweepLandedWorktrees(
      [wt()],
      new Set(['feat/landed']),
      { remove: false, isOpen: never },
    );
    expect(result.removed).toEqual([]);
    expect(result.blocked.get(lane)).toEqual({
      branch: 'feat/landed',
      blocker: 'off',
    });
    expect(fs.existsSync(lane)).toBe(true);
  });
});
