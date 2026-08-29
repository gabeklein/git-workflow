import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyIgnored,
  DEFAULT_EXPENDABLE_IGNORED,
  describeExpendable,
  ignoredEntryMatches,
  splitIgnored,
  summarizeIgnored,
} from '../../src/git/expendableIgnored';

/**
 * Which ignored files are worth a folder.
 *
 * The asymmetry the whole list is written against: a wrongly-EXPENDABLE
 * pattern deletes work nobody has a copy of, a wrongly-kept one costs
 * disk. So the interesting tests are the ones that prove a name does NOT
 * match rather than that it does.
 */
describe('ignoredEntryMatches', () => {
  it('matches a bare name at any depth', () => {
    // git reports what it collapsed, so both shapes arrive in practice.
    expect(ignoredEntryMatches('node_modules', 'node_modules')).toBe(true);
    expect(ignoredEntryMatches('node_modules/', 'node_modules')).toBe(true);
    expect(ignoredEntryMatches('develop/node_modules/', 'node_modules')).toBe(
      true,
    );
    expect(
      ignoredEntryMatches('a/b/node_modules/react/index.js', 'node_modules'),
    ).toBe(true);
  });

  it('does not match a name that merely contains the pattern', () => {
    // The failure this rules out is a `.env.production` folder or a
    // `my-dist-notes.md` disappearing because a substring matched.
    expect(ignoredEntryMatches('node_modules_backup', 'node_modules')).toBe(
      false,
    );
    expect(ignoredEntryMatches('dist-notes.md', 'dist')).toBe(false);
    expect(ignoredEntryMatches('predist/out.js', 'dist')).toBe(false);
  });

  it('anchors a pattern containing a slash at the checkout root', () => {
    expect(ignoredEntryMatches('vendor/bundle/', 'vendor/bundle')).toBe(true);
    expect(ignoredEntryMatches('vendor/bundle/ruby/3.2', 'vendor/bundle')).toBe(
      true,
    );
    // Somebody else's vendor directory is not ours to empty.
    expect(ignoredEntryMatches('app/vendor/bundle/', 'vendor/bundle')).toBe(
      false,
    );
    expect(ignoredEntryMatches('vendor/', 'vendor/bundle')).toBe(false);
  });

  it('globs within a segment only', () => {
    expect(ignoredEntryMatches('tsconfig.tsbuildinfo', '*.tsbuildinfo')).toBe(
      true,
    );
    expect(ignoredEntryMatches('logs/build.log', '*.log')).toBe(true);
    expect(ignoredEntryMatches('build.log/keep.txt', '*.log')).toBe(true);
    expect(ignoredEntryMatches('notes.logbook', '*.log')).toBe(false);
  });

  it('tolerates the shapes git and users actually write', () => {
    expect(ignoredEntryMatches('dist/', './dist')).toBe(true);
    expect(ignoredEntryMatches('dist/', 'dist/')).toBe(true);
    expect(ignoredEntryMatches('dist/', '')).toBe(false);
    expect(ignoredEntryMatches('', 'dist')).toBe(false);
  });

  it('never calls a secret or a local dump derived', () => {
    // The list is a promise about what removal may take. If any of these
    // start matching, a landed lane's unrecoverable file goes with it.
    for (const entry of [
      '.env',
      '.env.local',
      'develop/.env',
      'secrets.json',
      'local.db',
      'dump.sql',
      'notes.md',
      '.claude/settings.local.json',
      'credentials',
      'id_rsa',
    ]) {
      expect(splitIgnored([entry]).kept).toEqual([entry]);
    }
  });
});

describe('splitIgnored', () => {
  it('splits a real per-worktree install list', () => {
    const split = splitIgnored([
      'develop/node_modules/',
      'develop/test-results/',
      'node_modules',
      'dist/',
      '.env',
    ]);
    expect(split.kept).toEqual(['.env']);
    expect(split.expendable.map((e) => e.path)).toHaveLength(4);
    expect(split.expendable.every((e) => e.why === 'derived')).toBe(true);
  });

  it('blocks on everything when the list is emptied', () => {
    // `[]` is how a repo asks for the behavior that predates this: any
    // ignored file keeps the folder.
    const split = splitIgnored(['node_modules', 'dist/'], []);
    expect(split.expendable).toEqual([]);
    expect(split.kept).toHaveLength(2);
  });

  it('defaults carry every entry the built-in list names', () => {
    for (const pattern of DEFAULT_EXPENDABLE_IGNORED) {
      const entry = pattern.replace(/\*/g, 'x').replace(/\?/g, 'x');
      expect(splitIgnored([entry]).expendable).toEqual([
        { path: entry, why: 'derived' },
      ]);
    }
  });
});

describe('summarizeIgnored', () => {
  it('names up to three and counts the rest', () => {
    expect(summarizeIgnored(['a', 'b'])).toBe('a, b');
    expect(summarizeIgnored(['a', 'b', 'c', 'd', 'e'])).toBe(
      'a, b, c (+2 more)',
    );
  });
});

/**
 * The two halves that ask the disk rather than a list.
 *
 * Both answer one question — will these bytes still exist after the folder
 * goes — and neither is a guess about what the file is for. That is why
 * they are allowed to clear a `.env`, which no pattern ever should.
 */
describe('classifyIgnored', () => {
  let dir: string;
  let root: string;

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-expendable-'));
    root = path.join(base, 'repo');
    dir = path.join(root, '.worktrees', 'lane');
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(path.dirname(path.dirname(dir)), {
      recursive: true,
      force: true,
    });
  });

  const write = (where: string, rel: string, body: string) => {
    const full = path.join(where, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };

  it('clears a file the root checkout has byte for byte', async () => {
    // The .env copied into the lane so its tests would run. Deleting the
    // lane's copy destroys nothing: the bytes are one directory up.
    write(root, '.env', 'API_KEY=abc\n');
    write(dir, '.env', 'API_KEY=abc\n');
    const split = await classifyIgnored(['.env'], { dir, root });
    expect(split.kept).toEqual([]);
    expect(split.expendable).toEqual([{ path: '.env', why: 'same-as-root' }]);
  });

  it('keeps one that has drifted from the root by a single byte', async () => {
    // The lane added a key for the feature it is building. Same name, same
    // place, different file — and the only copy of that line.
    write(root, '.env', 'API_KEY=abc\n');
    write(dir, '.env', 'API_KEY=abc\nFEATURE_FLAG=1\n');
    const split = await classifyIgnored(['.env'], { dir, root });
    expect(split.expendable).toEqual([]);
    expect(split.kept).toEqual(['.env']);
  });

  it('keeps one the root does not have at all', async () => {
    write(dir, 'scratch.sql', 'select 1;\n');
    const split = await classifyIgnored(['scratch.sql'], { dir, root });
    expect(split.kept).toEqual(['scratch.sql']);
  });

  it('never compares a checkout against itself', async () => {
    // A file IS byte-identical to itself, so a root that is the same
    // folder would call everything expendable — the one way this check
    // could delete the last copy of something.
    write(dir, '.env', 'API_KEY=abc\n');
    const split = await classifyIgnored(['.env'], { dir, root: dir });
    expect(split.kept).toEqual(['.env']);
  });

  it('clears a symlink pointing out of the checkout', async () => {
    // The borrowed install AGENTS.md recommends: removing the link cannot
    // touch the target, whatever the target is.
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.symlinkSync('../../node_modules', path.join(dir, 'node_modules'));
    const split = await classifyIgnored(['node_modules'], {
      dir,
      root,
      // Empty pattern list: the link has to carry this on its own.
      patterns: [],
    });
    expect(split.expendable).toEqual([{ path: 'node_modules', why: 'link' }]);
    expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(true);
  });

  it('keeps a symlink pointing back INSIDE the checkout', async () => {
    // Its target goes with the folder, so the link is no evidence at all.
    write(dir, 'data/real.db', 'rows\n');
    fs.symlinkSync('data/real.db', path.join(dir, 'local.db'));
    const split = await classifyIgnored(['local.db'], {
      dir,
      root,
      patterns: [],
    });
    expect(split.kept).toEqual(['local.db']);
  });

  it('clears an entry that is already gone from the disk', async () => {
    // git listed it and a build removed it in between; there is nothing
    // left to lose, and blocking on it would be permanent.
    const split = await classifyIgnored(['dist/old.js'], {
      dir,
      root,
      patterns: [],
    });
    expect(split.expendable).toEqual([{ path: 'dist/old.js', why: 'gone' }]);
  });

  it('falls back to the pattern list for directories', async () => {
    // git collapses a wholly ignored directory to one entry, so identity
    // never sees inside one — which is the division of labour, not a gap.
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    write(dir, 'dist/main.js', 'built\n');
    const byPattern = await classifyIgnored(['dist/'], { dir, root });
    expect(byPattern.expendable).toEqual([{ path: 'dist/', why: 'derived' }]);
    const byIdentity = await classifyIgnored(['dist/'], {
      dir,
      root,
      patterns: [],
    });
    expect(byIdentity.kept).toEqual(['dist/']);
  });

  it('keeps a large file even when the root has the same bytes', async () => {
    // Past the hashing cap the honest answer is "this is big, let a human
    // look" — and anything derived that big is on the list anyway.
    const big = 'x'.repeat(9 * 1024 * 1024);
    write(root, 'fixture.bin', big);
    write(dir, 'fixture.bin', big);
    const split = await classifyIgnored(['fixture.bin'], { dir, root });
    expect(split.kept).toEqual(['fixture.bin']);
  });

  it('works with no root at all — patterns only', async () => {
    write(dir, '.env', 'API_KEY=abc\n');
    write(dir, 'dist/main.js', 'built\n');
    const split = await classifyIgnored(['.env', 'dist/'], { dir });
    expect(split.kept).toEqual(['.env']);
    expect(split.expendable).toEqual([{ path: 'dist/', why: 'derived' }]);
  });
});

describe('describeExpendable', () => {
  it('groups by reason, the auditable ones first', () => {
    // `.env (identical to the root's copy)` is the line somebody may one
    // day go looking for; node_modules is noise around it.
    const line = describeExpendable([
      { path: 'node_modules/', why: 'derived' },
      { path: '.env', why: 'same-as-root' },
      { path: 'vendor', why: 'link' },
    ]);
    expect(line).toBe(
      ".env (identical to the root checkout's copy); " +
        'vendor (symlinked out of the checkout); node_modules/ (derived)',
    );
  });
});
