/**
 * Which gitignored files are worth keeping a folder for.
 *
 * Ignored files are the one thing removing a checkout can actually
 * destroy — the dirty probe cannot see them and `git worktree remove`
 * takes them without complaint — so every removal path here treats "holds
 * ignored files" as a reason to stop. In a repo that installs
 * dependencies per worktree that reason fires every single time: a lane
 * whose branch landed months ago keeps its folder forever because it has
 * a `node_modules`, and the Landed group never empties.
 *
 * But `node_modules` is not what the rule is protecting. The rule is
 * protecting the `.env` nobody has a copy of, the local scratch file, the
 * database dump. A build output or an install directory is DERIVED — the
 * same command that made it makes it again — and holding a whole checkout
 * hostage to one is the mechanism defeating its own purpose.
 *
 * So ignored entries are split in two: the expendable ones, which are
 * named here and do not block anything, and everything else, which blocks
 * exactly as before. The split is a matter of policy rather than of git,
 * so it is configurable (`worktreeCompare.expendableIgnored`) and — being
 * the thing that decides whether a directory is deleted unattended — it is
 * pure, so a test can pin every pattern.
 */

/**
 * Ignored paths a landed checkout may be removed over.
 *
 * Every entry is something a build, install, or test run recreates from
 * the repo itself. Deliberately absent, and never to be added: anything
 * whose content exists only here — `.env` and friends above all, but also
 * local databases, dumps, notes, credentials. When in doubt the entry does
 * NOT belong in this list; the cost of leaving one out is a folder that
 * stays on disk, and the cost of putting one in is work that is gone.
 */
export const DEFAULT_EXPENDABLE_IGNORED: readonly string[] = [
  // Installs
  'node_modules',
  '.yarn/cache',
  '.pnpm-store',
  'bower_components',
  'vendor/bundle',
  '.bundle',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  'Pods',
  // Build output
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.output',
  '.parcel-cache',
  '.docusaurus',
  // Caches
  '.cache',
  '.turbo',
  '.vite',
  '.eslintcache',
  '.stylelintcache',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
  '.gradle',
  '.terraform',
  '.sass-cache',
  // Test and tooling output
  'coverage',
  '.nyc_output',
  'test-results',
  'playwright-report',
  'blob-report',
  '.vscode-test',
  '*.tsbuildinfo',
  '*.log',
  'npm-debug.log*',
  'yarn-error.log',
  // OS litter
  '.DS_Store',
  'Thumbs.db',
];

/**
 * Does one ignored entry match one pattern?
 *
 * gitignore-shaped, and only as much of it as the patterns above need:
 *
 *  - a pattern with no `/` matches ANY path segment, at any depth, so
 *    `node_modules` covers `develop/node_modules` without being listed
 *    twice;
 *  - a pattern with a `/` is anchored at the checkout root and matches a
 *    leading run of segments, so `vendor/bundle` covers
 *    `vendor/bundle/ruby/...` and never `app/vendor/bundle`;
 *  - `*` and `?` glob within a segment.
 *
 * The entry is whatever `git status --ignored` printed: a path relative to
 * the checkout, with a trailing `/` when git collapsed a whole directory.
 */
export function ignoredEntryMatches(entry: string, pattern: string): boolean {
  const segments = entry.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segments.length === 0) return false;
  const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (clean.length === 0) return false;

  if (!clean.includes('/'))
    return segments.some((segment) => globMatches(segment, clean));

  // Anchored: the pattern must be a leading run of the entry's segments,
  // which is also what makes a matched directory cover everything under it.
  const parts = clean.split('/').filter(Boolean);
  if (parts.length > segments.length) return false;
  return parts.every((part, index) => globMatches(segments[index], part));
}

/** `*` and `?` within a single segment; everything else is literal. */
function globMatches(segment: string, pattern: string): boolean {
  if (!/[*?]/.test(pattern)) return segment === pattern;
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`).test(segment);
}

export interface IgnoredSplit {
  /** Derived files a removal may take: recreated by a build or install. */
  expendable: string[];
  /** Everything else — each one a reason to keep the folder. */
  kept: string[];
}

/**
 * Split what a checkout holds into what may go and what may not.
 *
 * Callers block on `kept` and report `expendable`: a folder removed over a
 * `node_modules` should still SAY that is what happened, because the one
 * way this feature goes wrong is silently.
 */
export function splitIgnored(
  entries: readonly string[],
  patterns: readonly string[] = DEFAULT_EXPENDABLE_IGNORED,
): IgnoredSplit {
  const split: IgnoredSplit = { expendable: [], kept: [] };
  for (const entry of entries) {
    const matched = patterns.some((pattern) =>
      ignoredEntryMatches(entry, pattern),
    );
    (matched ? split.expendable : split.kept).push(entry);
  }
  return split;
}

/** Up to three names, then a count — log lines and dialogs, not manifests. */
export function summarizeIgnored(entries: readonly string[]): string {
  const head = entries.slice(0, 3).join(', ');
  const rest = entries.length - 3;
  return rest > 0 ? `${head} (+${rest} more)` : head;
}
