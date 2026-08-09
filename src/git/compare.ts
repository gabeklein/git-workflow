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
  baseRef: string;
  /** Resolved commit of base (short) */
  baseHead: string;
  ahead: number;
  behind: number;
  /** Newest-first commits on HEAD not in base */
  commitsAhead: CommitInfo[];
  /** Working tree + index vs base — Full PR file list (editable WT side) */
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

export async function compareWorkingTreeToBase(
  worktreePath: string,
  baseRef: string,
): Promise<CompareResult> {
  const baseHead = (await git(worktreePath, ['rev-parse', '--short', baseRef])).trim();

  const countOut = (
    await git(worktreePath, ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`])
  ).trim();
  // left = commits reachable from base not HEAD (behind), right = ahead
  const [behindStr, aheadStr] = countOut.split(/\s+/);
  const behind = Number(behindStr) || 0;
  const ahead = Number(aheadStr) || 0;

  const commitsAhead =
    ahead > 0
      ? parseCommits(
          await git(worktreePath, [
            'log',
            '--format=' + COMMIT_FORMAT,
            `${baseRef}..HEAD`,
          ]),
        )
      : [];

  // Working tree (and index) vs base — Full PR (includes uncommitted)
  const diffOut = await git(worktreePath, [
    'diff',
    '--name-status',
    '--find-renames',
    baseRef,
  ]);
  const fullPrFiles = parseNameStatus(diffOut);

  return {
    baseRef,
    baseHead,
    ahead,
    behind,
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
