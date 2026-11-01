import { git, GitError } from './exec';

/**
 * Several branches merged together, without a checkout — what Focus shows
 * when more than one branch is selected in Lanes.
 *
 * It is the preview's question asked once and thrown away: what would
 * landing these together produce, and where do they clash? Built with
 * `merge-tree`, so nothing is checked out and no branch moves. The result
 * is a commit (one merge per extra branch) pinned under COMBINED_REF so it
 * outlives gc while Focus shows it; the next selection replaces it.
 */
export const COMBINED_REF = 'refs/gw/combined';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'git-workflow',
  GIT_AUTHOR_EMAIL: 'git-workflow@localhost',
  GIT_COMMITTER_NAME: 'git-workflow',
  GIT_COMMITTER_EMAIL: 'git-workflow@localhost',
};

export interface Combined {
  /** The merged commit, focusable like any ref. */
  sha: string;
  /** Common ancestor of every branch — what the result is diffed against. */
  base: string;
  /** Paths that clashed; the tree holds them with conflict markers. */
  conflicts: string[];
}

export async function buildCombined(
  repo: string,
  refs: string[],
): Promise<Combined> {
  if (refs.length < 2) throw new Error('combining needs at least two branches');
  const base = (await git(repo, ['merge-base', '--octopus', ...refs])).trim();
  if (!base) throw new Error(`${refs.join(', ')} share no history`);

  let head = (await git(repo, ['rev-parse', `${refs[0]}^{commit}`])).trim();
  const conflicts = new Set<string>();
  for (const next of refs.slice(1)) {
    let out: string;
    try {
      out = await git(repo, ['merge-tree', '--write-tree', '--name-only', head, next]);
    } catch (err) {
      // Exit 1 is "merged, with conflicts" — the tree is still written.
      if (!(err instanceof GitError) || !err.stdout) throw err;
      out = err.stdout;
    }
    // Tree id, then conflicted paths, then a blank line and the messages.
    const [tree, ...rest] = out.split('\n');
    for (const line of rest) {
      if (!line.trim()) break;
      conflicts.add(line.trim());
    }
    // A throwaway commit: its own identity, so a repo with none configured
    // can still combine.
    head = (
      await git(
        repo,
        ['commit-tree', tree.trim(), '-p', head, '-p', next, '-m', `combined: ${refs.join(' + ')}`],
        IDENTITY,
      )
    ).trim();
  }
  await git(repo, ['update-ref', COMBINED_REF, head]);
  return { sha: head, base, conflicts: [...conflicts] };
}
