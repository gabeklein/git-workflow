import { git } from './exec';

export type RefKind = 'head' | 'local' | 'remote' | 'tag';

export interface GitRef {
  /** Name suitable for rev-parse (e.g. main, origin/main, v1.0.0, HEAD) */
  name: string;
  kind: RefKind;
  shortHash?: string;
  relativeDate?: string;
}

/**
 * List refs available for comparison: HEAD, local branches, remotes, tags.
 */
export async function listCompareRefs(worktreePath: string): Promise<GitRef[]> {
  const refs: GitRef[] = [{ name: 'HEAD', kind: 'head' }];

  try {
    // %(refname:short) · short hash · relative date · full refname for kind detection
    const out = await git(worktreePath, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)%00%(objectname:short)%00%(committerdate:relative)%00%(refname)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ]);

    for (const line of out.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const [name, shortHash, relativeDate, fullRef] = line.split('\0');
      if (!name || !fullRef) {
        continue;
      }
      // Skip remote HEAD pointers (origin/HEAD)
      if (name.endsWith('/HEAD') || fullRef.endsWith('/HEAD')) {
        continue;
      }
      let kind: RefKind = 'local';
      if (fullRef.startsWith('refs/remotes/')) {
        kind = 'remote';
      } else if (fullRef.startsWith('refs/tags/')) {
        kind = 'tag';
      }
      refs.push({
        name,
        kind,
        shortHash: shortHash || undefined,
        relativeDate: relativeDate || undefined,
      });
    }
  } catch {
    // Caller can still allow free-typed refs
  }

  return refs;
}
