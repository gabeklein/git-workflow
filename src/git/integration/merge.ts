import { git, GitError } from '../exec';
import { autoResolveArgs } from './config';

export async function mergeOffTree(
  cwd: string,
  ours: string,
  theirs: string,
  opts?: { strict?: boolean },
): Promise<
  | { kind: 'tree'; tree: string }
  | { kind: 'conflict'; files: string[] }
  | { kind: 'unsupported' }
> {
  try {
    const out = await git(cwd, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      // strict: decisions (like landed detection) must not vary with the
      // user's auto-resolve preference
      ...(opts?.strict ? [] : autoResolveArgs()),
      ours,
      theirs,
    ]);
    return { kind: 'tree', tree: out.trim().split('\n')[0]!.trim() };
  } catch (err) {
    if (err instanceof GitError) {
      // Exit 1 = clean run, conflicts found. Stdout sections are separated
      // by a blank line: oid, conflicted file names, informational messages.
      if (err.code === 1 && err.stdout.trim()) {
        const lines = err.stdout.split('\n').map((l) => l.trim());
        const files: string[] = [];
        for (const line of lines.slice(1)) {
          if (!line) {
            break;
          }
          files.push(line);
        }
        return { kind: 'conflict', files };
      }
      if (
        err.stderr.includes('usage:') ||
        err.stderr.includes('--write-tree') ||
        err.code === 129
      ) {
        return { kind: 'unsupported' };
      }
    }
    throw err;
  }
}

/**
 * Rebuild the integration checkout: compute base + `--no-ff`-style merge
 * of each applied lane off-tree, then apply the result with one
 * `reset --hard`. Refuses when the checkout is dirty or carries commits
 * that belong to no lane. A conflicting lane fails the rebuild WITHOUT
 * touching the working tree.
 */
