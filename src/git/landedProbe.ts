import { git, gitOk } from './exec';
// Imported from the module, not the barrel: status.ts uses this, and
// the barrel re-exports status.ts — going through it would be a cycle.
import { mergeOffTree } from './integration/merge';

/**
 * Deciding whether a branch's work is already in the base.
 *
 * `git branch -d` answers this by ANCESTRY, which is wrong for every
 * squash merge. The first attempt here answered it by merging the branch
 * into the base and checking the tree came back unchanged — correct for a
 * branch that landed recently, and quietly useless once the base moves on:
 * later work touching the same files makes that merge conflict, the probe
 * reports "not landed", and the branch survives forever. Measured on this
 * repo, 7 of 10 genuinely-landed branches were missed that way — precisely
 * the stale crust the prune exists to clear.
 *
 * No single git-only test covers it, so this stacks several. Every one is
 * SOUND — it can only say "landed" when the work really is in the base —
 * and any of them may say nothing, so their union is a strictly better
 * answer than any alone, and a miss still means "keep the branch".
 *
 * That asymmetry is the whole safety story: a false negative wastes a
 * branch's disk, a false positive deletes work.
 *
 * It also rules out the history-based tests. `git cherry` and patch-id
 * comparison both answer "did this work ever land", and a reverted
 * squash-merge still says yes to both — while the work is no longer in the
 * base, and the branch that could restore it is exactly what would be
 * deleted. Every probe below therefore ends by checking the CURRENT tree.
 */

/** Commits of base history to scan. Beyond this, a branch is not "recent". */
const MAX_SCAN = 200;

export type LandedVia = 'ancestor' | 'content' | 'squash';

/**
 * Has `branchSha`'s work landed in `baseSha`, and how?
 *
 * Ordered cheapest-first, and every probe is skipped the moment an earlier
 * one answers.
 */
export async function landedVia(
  cwd: string,
  branchSha: string,
  baseSha: string,
): Promise<LandedVia | undefined> {
  // 1. True merge, or the branch simply never diverged.
  if (await gitOk(cwd, ['merge-base', '--is-ancestor', branchSha, baseSha])) {
    return 'ancestor';
  }

  const fork = (
    await git(cwd, ['merge-base', baseSha, branchSha]).catch(() => '')
  ).trim();
  if (!fork) {
    return undefined; // unrelated histories
  }

  const baseTree = (
    await git(cwd, ['rev-parse', `${baseSha}^{tree}`]).catch(() => '')
  ).trim();

  // 2. Merging it into the base right now changes nothing. Cheap, and the
  //    common case for a branch that landed while the base sat still.
  if (baseTree) {
    try {
      const result = await mergeOffTree(cwd, baseSha, branchSha, {
        strict: true,
      });
      if (result.kind === 'tree' && result.tree === baseTree) {
        return 'content';
      }
    } catch {
      // probe failed — fall through, never conclude from a failure
    }
  }

  const history = (
    await git(cwd, [
      'rev-list',
      `--max-count=${MAX_SCAN}`,
      `${fork}..${baseSha}`,
    ]).catch(() => '')
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // 3. Reproduce the squash. GitHub builds a squash commit by merging the
  //    branch into the base as it stood just before — so if applying the
  //    branch to some commit's PARENT yields exactly that commit's tree,
  //    that commit IS this branch, whatever its message says. Survives the
  //    base moving on afterwards, which is what defeats probe 2.
  //
  //    A cumulative patch-id comparison was tried here too and turned out
  //    to be strictly weaker: it matched the same branches this does, and
  //    missed one more, because a squash computed on top of intervening
  //    edits to the same files has different context and so a different
  //    patch-id. This asks about the resulting TREE, which does not care.
  for (const commit of history) {
    const parent = (
      await git(cwd, ['rev-parse', '-q', '--verify', `${commit}^`]).catch(
        () => '',
      )
    ).trim();
    if (!parent) {
      continue;
    }
    try {
      const result = await mergeOffTree(cwd, parent, branchSha, {
        mergeBase: fork,
      });
      const tree = (
        await git(cwd, ['rev-parse', `${commit}^{tree}`]).catch(() => '')
      ).trim();
      if (result.kind !== 'tree' || !tree || result.tree !== tree) {
        continue;
      }
      // Found where it landed. Now: is the work still there? Re-apply
      // that commit's own delta to the base as it stands, and read the
      // three outcomes apart —
      //
      //   no-op        the landing is intact; nothing has touched it
      //   CONFLICT     later work evolved the same lines. Still landed:
      //                the base built ON this, it did not discard it
      //   clean change the work is cleanly absent, so re-applying restores
      //                it — that is a revert, and the branch is the way
      //                back. Never offer it for deletion
      //
      // The middle case is the whole reason this probe exists: requiring a
      // no-op here dropped real coverage from 9 of 10 landed branches to 4,
      // because in a busy repo something always touches those files again.
      const still = await mergeOffTree(cwd, baseSha, commit, {
        mergeBase: parent,
        strict: true,
      });
      if (still.kind === 'conflict') {
        return 'squash';
      }
      if (still.kind === 'tree' && baseTree && still.tree === baseTree) {
        return 'squash';
      }
      // Cleanly removed — reverted. Stop: we know where it went.
      return undefined;
    } catch {
      // keep scanning
    }
  }

  return undefined;
}
