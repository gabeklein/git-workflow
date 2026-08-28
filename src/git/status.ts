import { git } from './exec';
import type { FileChange } from './compare';

export interface WorkingStatus {
  staged: FileChange[];
  unstaged: FileChange[];
}

/**
 * Staged / unstaged lists via the same diffs the UI opens:
 * - staged:   `git diff --cached`  (HEAD ↔ index)
 * - unstaged: `git diff` + untracked (index ↔ working tree)
 *
 * Prefer this over porcelain XY parsing — clearer and harder to mis-split.
 */
export async function getWorkingStatus(worktreePath: string): Promise<WorkingStatus> {
  const [stagedOut, unstagedOut, untrackedOut] = await Promise.all([
    git(worktreePath, ['diff', '--name-status', '--cached', '--find-renames']),
    git(worktreePath, ['diff', '--name-status', '--find-renames']),
    git(worktreePath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
  ]);

  const staged = parseNameStatus(stagedOut);
  const unstaged = parseNameStatus(unstagedOut);

  // Untracked: not "A" (that is index/tree-added). Mark as '?' → UI letter U.
  for (const filePath of parseNulPaths(untrackedOut)) {
    if (!unstaged.some((f) => f.path === filePath))
      unstaged.push({ path: filePath, status: '?' });
  }

  staged.sort((a, b) => a.path.localeCompare(b.path));
  unstaged.sort((a, b) => a.path.localeCompare(b.path));
  return { staged, unstaged };
}

function parseNameStatus(stdout: string): FileChange[] {
  const files: FileChange[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
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
    } else if (parts.length >= 2 && parts[1]) {
      files.push({
        status,
        path: parts[1],
      });
    }
  }
  return files;
}

function parseNulPaths(stdout: string): string[] {
  return stdout
    .split('\0')
    .map((p) => p.trim())
    .filter(Boolean);
}
