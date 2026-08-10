import { git } from './exec';

export interface CommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** Relative date from git, e.g. "2 hours ago" */
  relativeDate: string;
}

export interface FileChange {
  /** Path relative to worktree root, git-style (forward slashes) */
  path: string;
  /** Status letter: A M D R C T etc. */
  status: string;
  /** For renames, the previous path */
  oldPath?: string;
}

export interface CompareResult {
  /**
   * Integration tip the user cares about (e.g. origin/main).
   * Diffs/logs use {@link compareRef} (merge-base with HEAD by default).
   */
  baseRef: string;
  /**
   * Actual commit used for ahead/diff (usually merge-base(HEAD, baseRef)).
   * Short or full — whatever `rev-parse` returned for the compare point.
   */
  compareRef: string;
  /** Short sha of compareRef (fork / pin point) */
  baseHead: string;
  /** Short sha of the integration tip (baseRef) */
  baseTipHead: string;
  /**
   * True when compare point is the tip itself (not an older merge-base).
   * Used to omit `@ sha` in the UI when there's nothing to pin.
   */
  compareIsTip: boolean;
  ahead: number;
  /**
   * Commits on the integration tip that are not in HEAD.
   * Informational only — does not mean "must rebase"; conflicts come from GitHub.
   */
  tipBehind: number;
  /** Newest-first commits on HEAD not in compareRef */
  commitsAhead: CommitInfo[];
  /**
   * Working tree + index vs compareRef — committed ahead *and* uncommitted.
   * Not the same as “sum of Ahead commits” alone (those are commit-only).
   */
  fullPrFiles: FileChange[];
}

const COMMIT_FORMAT = ['%H', '%h', '%s', '%an', '%ar'].join('%x1f') + '%x1e';

function parseCommits(stdout: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const record of stdout.split('\x1e')) {
    const trimmed = record.trim();
    if (!trimmed) {
      continue;
    }
    const [hash, shortHash, subject, author, relativeDate] = trimmed.split('\x1f');
    if (!hash) {
      continue;
    }
    commits.push({
      hash,
      shortHash: shortHash ?? hash.slice(0, 7),
      subject: subject ?? '',
      author: author ?? '',
      relativeDate: relativeDate ?? '',
    });
  }
  return commits;
}

function parseNameStatus(stdout: string): FileChange[] {
  const files: FileChange[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    // M\tpath | A\tpath | D\tpath | R100\told\tnew
    const parts = line.split('\t');
    const statusRaw = parts[0] ?? '';
    const status = statusRaw.charAt(0) || 'M';
    if (parts.length >= 3 && (status === 'R' || status === 'C')) {
      files.push({
        status,
        oldPath: parts[1],
        path: parts[2] ?? parts[1],
      });
    } else if (parts.length >= 2) {
      files.push({
        status,
        path: parts[1],
      });
    }
  }
  return files;
}

export interface FileChangeBreakdown {
  added: number;
  modified: number;
  deleted: number;
}

/** Count A / M(etc) / D for section descriptions. Renames & copies count as modified. */
export function breakdownFileChanges(files: FileChange[]): FileChangeBreakdown {
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const f of files) {
    switch (f.status) {
      case 'A':
      case '?':
        added += 1;
        break;
      case 'D':
        deleted += 1;
        break;
      default:
        // M, T, R, C, U, etc.
        modified += 1;
        break;
    }
  }
  return { added, modified, deleted };
}

/** e.g. `2 new · 1 untracked · 5 modified · 1 deleted` (omits zero buckets). */
export function formatFileChangeBreakdown(files: FileChange[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  let added = 0;
  let untracked = 0;
  let modified = 0;
  let deleted = 0;
  for (const f of files) {
    switch (f.status) {
      case 'A':
        added += 1;
        break;
      case '?':
        untracked += 1;
        break;
      case 'D':
        deleted += 1;
        break;
      default:
        modified += 1;
        break;
    }
  }
  const parts: string[] = [];
  if (added > 0) {
    parts.push(`${added} new`);
  }
  if (untracked > 0) {
    parts.push(`${untracked} untracked`);
  }
  if (modified > 0) {
    parts.push(`${modified} modified`);
  }
  if (deleted > 0) {
    parts.push(`${deleted} deleted`);
  }
  return parts.length > 0 ? parts.join(' · ') : String(files.length);
}

/**
 * Compare working tree to an integration tip.
 *
 * By default pins the compare point to merge-base(HEAD, baseTipRef) — the
 * newest commit on that lineage that is still an ancestor of the worktree.
 * That yields a PR-style file list / ahead list without treating "main moved
 * on" as a behind/rebase warning.
 */
export async function compareWorkingTreeToBase(
  worktreePath: string,
  baseTipRef: string,
  options?: { pinToMergeBase?: boolean },
): Promise<CompareResult> {
  const pinToMergeBase = options?.pinToMergeBase !== false;

  let compareRef = baseTipRef;
  if (pinToMergeBase) {
    try {
      const mb = (
        await git(worktreePath, ['merge-base', 'HEAD', baseTipRef])
      ).trim();
      if (mb) {
        compareRef = mb;
      }
    } catch {
      // Detached / unrelated histories — fall back to tip
      compareRef = baseTipRef;
    }
  }

  const [baseHead, baseTipHead] = await Promise.all([
    git(worktreePath, ['rev-parse', '--short', compareRef]).then((s) =>
      s.trim(),
    ),
    git(worktreePath, ['rev-parse', '--short', baseTipRef]).then((s) =>
      s.trim(),
    ),
  ]);
  const compareIsTip = baseHead === baseTipHead;

  // tipBehind: commits on integration tip not in HEAD (main moved forward)
  let tipBehind = 0;
  try {
    const tipBehindOut = (
      await git(worktreePath, [
        'rev-list',
        '--count',
        `HEAD..${baseTipRef}`,
      ])
    ).trim();
    tipBehind = Number(tipBehindOut) || 0;
  } catch {
    tipBehind = 0;
  }

  const countOut = (
    await git(worktreePath, [
      'rev-list',
      '--left-right',
      '--count',
      `${compareRef}...HEAD`,
    ])
  ).trim();
  // left should be 0 when compareRef is merge-base; right = ahead
  const [, aheadStr] = countOut.split(/\s+/);
  const ahead = Number(aheadStr) || 0;

  const commitsAhead =
    ahead > 0
      ? parseCommits(
          await git(worktreePath, [
            'log',
            '--format=' + COMMIT_FORMAT,
            `${compareRef}..HEAD`,
          ]),
        )
      : [];

  // Working tree (and index) vs fork point — Full Diff (includes uncommitted).
  // `git diff <ref>` omits untracked files; merge those in as '?' (UI: U).
  const [diffOut, untrackedOut] = await Promise.all([
    git(worktreePath, [
      'diff',
      '--name-status',
      '--find-renames',
      compareRef,
    ]),
    git(worktreePath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
  ]);
  const fullPrFiles = parseNameStatus(diffOut);
  const seen = new Set(fullPrFiles.map((f) => f.path));
  for (const filePath of untrackedOut
    .split('\0')
    .map((p) => p.trim())
    .filter(Boolean)) {
    if (!seen.has(filePath)) {
      fullPrFiles.push({ path: filePath, status: '?' });
      seen.add(filePath);
    }
  }
  fullPrFiles.sort((a, b) => a.path.localeCompare(b.path));

  return {
    baseRef: baseTipRef,
    compareRef,
    baseHead,
    baseTipHead,
    compareIsTip,
    ahead,
    tipBehind,
    commitsAhead,
    fullPrFiles,
  };
}

export async function listCommitFiles(
  worktreePath: string,
  commitHash: string,
): Promise<FileChange[]> {
  const out = await git(worktreePath, [
    'diff-tree',
    '--no-commit-id',
    '--name-status',
    '-r',
    '--find-renames',
    commitHash,
  ]);
  return parseNameStatus(out);
}

/**
 * Read file contents at a ref; empty string if missing.
 * Special ref `INDEX` (or `:` / `:0`) reads the staging-area blob.
 */
export async function showFileAtRef(
  worktreePath: string,
  ref: string,
  relativePath: string,
): Promise<string> {
  try {
    if (ref === 'INDEX' || ref === ':' || ref === ':0') {
      return await git(worktreePath, ['show', `:${relativePath}`]);
    }
    return await git(worktreePath, ['show', `${ref}:${relativePath}`]);
  } catch {
    return '';
  }
}
