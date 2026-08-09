import { git } from './exec';
import type { FileChange } from './compare';

export interface WorkingStatus {
  staged: FileChange[];
  unstaged: FileChange[];
}

/**
 * Parse `git status --porcelain=v1 -uall` into staged / unstaged lists.
 * A path can appear in both (e.g. staged edit + further unstaged edits).
 */
export async function getWorkingStatus(worktreePath: string): Promise<WorkingStatus> {
  const out = await git(worktreePath, [
    'status',
    '--porcelain=v1',
    '-uall',
    '--ignore-submodules=dirty',
  ]);

  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  const seenStaged = new Set<string>();
  const seenUnstaged = new Set<string>();

  for (const raw of out.split('\n')) {
    if (!raw) {
      continue;
    }
    // Format: XY PATH | XY ORIG -> PATH | ?? PATH
    const x = raw[0] ?? ' ';
    const y = raw[1] ?? ' ';
    const rest = raw.slice(3);

    if (x === '?' && y === '?') {
      const path = rest.trim();
      if (path && !seenUnstaged.has(path)) {
        seenUnstaged.add(path);
        unstaged.push({ path, status: 'A' });
      }
      continue;
    }
    if (x === '!' && y === '!') {
      continue;
    }

    let path = rest;
    let oldPath: string | undefined;
    const renameIdx = rest.indexOf(' -> ');
    if (renameIdx !== -1 && (x === 'R' || x === 'C' || y === 'R' || y === 'C')) {
      oldPath = rest.slice(0, renameIdx).trim();
      path = rest.slice(renameIdx + 4).trim();
    } else {
      path = rest.trim();
    }
    if (!path) {
      continue;
    }

    // Staged: index column has a change
    if (x !== ' ' && x !== '?') {
      const key = path;
      if (!seenStaged.has(key)) {
        seenStaged.add(key);
        staged.push({
          path,
          oldPath,
          status: normalizeStatus(x),
        });
      }
    }

    // Unstaged: worktree column has a change
    if (y !== ' ' && y !== '?') {
      const key = path;
      if (!seenUnstaged.has(key)) {
        seenUnstaged.add(key);
        unstaged.push({
          path,
          oldPath: y === 'R' || y === 'C' ? oldPath : undefined,
          status: normalizeStatus(y),
        });
      }
    }
  }

  staged.sort((a, b) => a.path.localeCompare(b.path));
  unstaged.sort((a, b) => a.path.localeCompare(b.path));
  return { staged, unstaged };
}

function normalizeStatus(code: string): string {
  switch (code) {
    case 'A':
    case 'M':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
    case 'U':
      return code;
    default:
      return 'M';
  }
}
