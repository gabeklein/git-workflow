import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPENDABLE_IGNORED,
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
    expect(split.expendable).toHaveLength(4);
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
      expect(splitIgnored([entry]).expendable).toEqual([entry]);
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
