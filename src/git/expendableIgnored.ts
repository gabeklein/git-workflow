import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

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
 * So ignored entries are split in two: the expendable ones, which do not
 * block anything, and everything else, which blocks exactly as before.
 * Three ways to earn expendable, cheapest and most certain first:
 *
 *  - a **symlink out of the checkout** (`node_modules -> ../../node_modules`,
 *    which is how a lane borrows the root's install). Removing a link never
 *    touches its target, so this one is true by construction — no reading,
 *    no policy;
 *  - a file **byte-identical to the root checkout's** at the same relative
 *    path — the `.env` copied into the lane so tests would run. This is the
 *    strongest evidence available, because it is not a guess about what the
 *    file is: the bytes provably still exist one directory up after the
 *    folder goes;
 *  - a **match against the pattern list**, for what is generated rather than
 *    copied. Necessary because `git status --ignored` collapses a wholly
 *    ignored DIRECTORY to a single entry, and comparing those by content
 *    means walking two trees in the one case where walking is unaffordable
 *    and the answer is "differs" anyway. So identity covers files, patterns
 *    cover directories — a division git's own output makes for us.
 *
 * The pattern half is policy, so it is configurable
 * (`worktreeCompare.expendableIgnored`) and pure, so a test can pin every
 * entry. The other two halves are questions about the disk, kept here
 * beside it and answered fresh — this decides whether a directory is
 * deleted unattended, and a cached answer is a snapshot.
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

/** How an ignored entry earned its way onto the expendable side. */
export type ExpendableReason =
  /** A symlink whose target lives outside the checkout. */
  | 'link'
  /** Byte-identical to the root checkout's file at the same path. */
  | 'same-as-root'
  /** Matches the derived-file pattern list. */
  | 'derived'
  /** Nothing is there any more — git listed it, the disk disagrees. */
  | 'gone';

export interface ExpendableIgnored {
  path: string;
  why: ExpendableReason;
}

export interface IgnoredSplit {
  /** Files a removal may take, each with the reason it may. */
  expendable: ExpendableIgnored[];
  /** Everything else — each one a reason to keep the folder. */
  kept: string[];
}

/**
 * The pattern half on its own: no disk, no root checkout, no I/O.
 *
 * Exported because it is the part a test can exhaust, and because a caller
 * that has no root to compare against (or is asking a hypothetical) still
 * gets a usable answer.
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
    if (matched) split.expendable.push({ path: entry, why: 'derived' });
    else split.kept.push(entry);
  }
  return split;
}

/**
 * A file big enough to be worth a folder on its own.
 *
 * The cap is on the identity check, not on the patterns: hashing every
 * ignored file in a checkout is work done to decide a deletion, and past
 * some size the honest answer is "this is large, keep the folder and let
 * a human look". Build output that big is on the pattern list anyway.
 */
const MAX_HASHED_BYTES = 8 * 1024 * 1024;

/**
 * Split what a checkout holds into what may go and what may not, asking
 * the disk.
 *
 * Callers block on `kept` and report `expendable` WITH its reason: a
 * folder removed over somebody's `.env` should say that it went because
 * the root has the same bytes, since "identical to the root's copy" is a
 * claim that ought to be auditable after the fact. Silence is the one way
 * this feature goes wrong.
 */
export async function classifyIgnored(
  entries: readonly string[],
  options: {
    /** The checkout the entries are relative to, and that may be removed. */
    dir: string;
    /**
     * The checkout that will still be there afterwards. Omitted — or equal
     * to `dir` — and the identity half is skipped entirely: a file is not
     * evidence of its own survival.
     */
    root?: string;
    patterns?: readonly string[];
  },
): Promise<IgnoredSplit> {
  const patterns = options.patterns ?? DEFAULT_EXPENDABLE_IGNORED;
  const isSelf = await sameDirectory(options.dir, options.root);
  const root = isSelf ? undefined : options.root;
  const split: IgnoredSplit = { expendable: [], kept: [] };

  for (const entry of entries) {
    const why = await classifyEntry(entry, options.dir, root, patterns);
    if (why) split.expendable.push({ path: entry, why });
    else split.kept.push(entry);
  }
  return split;
}

/** The reason this entry may go, or undefined: it keeps the folder. */
async function classifyEntry(
  entry: string,
  dir: string,
  root: string | undefined,
  patterns: readonly string[],
): Promise<ExpendableReason | undefined> {
  const relative = entry.replace(/\/+$/, '');
  const full = path.join(dir, relative);

  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(full);
  } catch {
    // git listed it and it is not there: deleted since the status ran, or
    // a race with a build. Nothing to lose either way.
    return 'gone';
  }

  if (stat.isSymbolicLink()) {
    // Removing a link removes the link. Whether the TARGET survives is the
    // only question, and it does whenever it lives outside the folder
    // being deleted — the borrowed-install shape AGENTS.md recommends.
    if (await targetIsOutside(full, dir)) return 'link';
  } else if (stat.isFile() && root && stat.size <= MAX_HASHED_BYTES) {
    if (await identicalToRoot(full, path.join(root, relative), stat.size))
      return 'same-as-root';
  }

  // Directories, big files, and anything the disk would not answer for
  // fall to policy — which is what the list is for.
  return patterns.some((pattern) => ignoredEntryMatches(entry, pattern))
    ? 'derived'
    : undefined;
}

/** Does this symlink point somewhere the removal will not reach? */
async function targetIsOutside(link: string, dir: string): Promise<boolean> {
  let target: string;
  try {
    target = await fsp.realpath(link);
  } catch {
    // Broken link: there is no target to lose.
    return true;
  }
  let base: string;
  try {
    // Through realpath on both sides, or a symlinked parent (/tmp on
    // macOS is /private/tmp) reads as "outside" and every link qualifies.
    base = await fsp.realpath(dir);
  } catch {
    return false;
  }
  return !(target === base || target.startsWith(base + path.sep));
}

/** Byte-identical, cheapest disqualifier first. */
async function identicalToRoot(
  file: string,
  counterpart: string,
  size: number,
): Promise<boolean> {
  try {
    const other = await fsp.lstat(counterpart);
    if (!other.isFile() || other.size !== size) return false;
  } catch {
    // The root has no copy: this file exists in exactly one place.
    return false;
  }
  const [a, b] = await Promise.all([hash(file), hash(counterpart)]);
  return a !== undefined && a === b;
}

async function hash(file: string): Promise<string | undefined> {
  try {
    return createHash('sha256')
      .update(await fsp.readFile(file))
      .digest('hex');
  } catch {
    return undefined;
  }
}

/** Same folder on disk, symlinked parents and trailing slashes included. */
async function sameDirectory(a: string, b?: string): Promise<boolean> {
  if (!b) return true;
  const real = async (p: string) => {
    try {
      return await fsp.realpath(p);
    } catch {
      return path.resolve(p);
    }
  };
  return (await real(a)) === (await real(b));
}

/** Up to three names, then a count — log lines and dialogs, not manifests. */
export function summarizeIgnored(
  entries: readonly (string | ExpendableIgnored)[],
): string {
  const names = entries.map((e) => (typeof e === 'string' ? e : e.path));
  const head = names.slice(0, 3).join(', ');
  const rest = names.length - 3;
  return rest > 0 ? `${head} (+${rest} more)` : head;
}

/**
 * What the log says a removal took, grouped by why it was allowed to.
 *
 * Grouped rather than listed flat because the reasons are not equally
 * reassuring: `node_modules (derived)` is routine and `.env (identical to
 * the root's copy)` is the line somebody may one day want to find.
 */
export function describeExpendable(
  entries: readonly ExpendableIgnored[],
): string {
  const wording: Record<ExpendableReason, string> = {
    link: 'symlinked out of the checkout',
    'same-as-root': "identical to the root checkout's copy",
    derived: 'derived',
    gone: 'already gone',
  };
  const order: ExpendableReason[] = ['same-as-root', 'link', 'derived', 'gone'];
  return order
    .flatMap((why) => {
      const group = entries.filter((e) => e.why === why);
      return group.length === 0
        ? []
        : [`${summarizeIgnored(group)} (${wording[why]})`];
    })
    .join('; ');
}
