import { git } from './exec';
import { resolveBaseSha } from './integration';
import { landedVia } from './landedProbe';
import { revParseCommit } from './plumbing';
import { listWorktreeAdmin } from './worktreeAdmin';

/**
 * Finding local branches whose work is already in the base, so they can be
 * deleted without reading every one by hand.
 *
 * `git branch -d` cannot do this. It decides "merged" by ANCESTRY, and a
 * squash-merged branch is not an ancestor of anything — so it refuses, and
 * the only way past it is `-D`, which deletes unmerged work just as
 * happily as merged work. At any real merge rate the local branch list
 * grows without bound and nobody dares run the blunt version.
 *
 * The predicate lives in landedProbe: a stack of sound tests covering
 * true merges, fresh squashes, squashes the base has since moved past, and
 * rebase landings. Revert-safe by construction — once a squash-merge is
 * reverted, the branch stops reading as landed and survives the prune.
 *
 * Everything here reads. Deletion is a separate, explicit step.
 */

export interface LandedBranch {
  name: string;
  /** How it landed — worth showing, they mean different things. */
  via: 'ancestor' | 'content' | 'squash' | 'replayed';
  /** Checkout holding it, if any: git refuses to delete a checked-out branch. */
  worktree?: string;
  /** Still published — deleting locally does not delete origin's copy. */
  hasRemote: boolean;
}

interface LandedScan {
  landed: LandedBranch[];
  /** Branches with real unlanded work — never offered, counted for honesty. */
  keptCount: number;
}

/**
 * Local branches already contained in `baseRef`.
 *
 * `protect` names branches that must never be offered whatever the probe
 * says — the base itself, the integration branch, anything the caller
 * knows is structural rather than a unit of work.
 */
export async function findLandedBranches(
  repoCwd: string,
  baseRef: string,
  protect: string[] = [],
): Promise<LandedScan> {
  const baseSha = await resolveBaseSha(repoCwd, baseRef);
  if (!baseSha) return { landed: [], keptCount: 0 };
  const admin = await listWorktreeAdmin(repoCwd).catch(
    () => new Map<string, { branch?: string; path: string; detached: boolean }>(),
  );
  const heldBy = new Map<string, string>();
  for (const state of admin.values()) {
    if (!state.detached && state.branch) heldBy.set(state.branch, state.path);
  }

  const locals = (
    await git(repoCwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const remotes = new Set(
    (
      await git(repoCwd, [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/remotes/origin',
      ]).catch(() => '')
    )
      .split('\n')
      .map((l) => l.trim().replace(/^origin\//, ''))
      .filter(Boolean),
  );

  const guard = new Set([
    ...protect,
    baseRef.replace(/^origin\//, ''),
  ]);

  const landed: LandedBranch[] = [];
  let keptCount = 0;
  for (const name of locals) {
    if (guard.has(name)) continue;
    const sha = await revParseCommit(repoCwd, `refs/heads/${name}`);
    if (!sha || sha === baseSha) continue;
    // Every probe is sound and any may abstain, so a miss means "keep it".
    const via = await landedVia(repoCwd, sha, baseSha).catch(() => undefined);
    if (!via) {
      keptCount += 1;
      continue;
    }
    landed.push({
      name,
      via,
      worktree: heldBy.get(name),
      hasRemote: remotes.has(name),
    });
  }
  return { landed, keptCount };
}

interface PruneOutcome {
  deleted: string[];
  /** Name → why it survived. */
  failed: Map<string, string>;
}

/**
 * Delete the named branches with `-D`.
 *
 * The force flag is not a shortcut here: `-d` would refuse every
 * squash-merged branch, which is most of them. Safety comes from the
 * caller only ever passing names that findLandedBranches proved landed —
 * so each branch is re-verified against the base immediately before it is
 * deleted, rather than trusting a list that may have gone stale while a
 * confirmation dialog was open.
 */
export async function pruneLandedBranches(
  repoCwd: string,
  baseRef: string,
  names: string[],
  protect: string[] = [],
): Promise<PruneOutcome> {
  const deleted: string[] = [];
  const failed = new Map<string, string>();
  if (names.length === 0) return { deleted, failed };
  const fresh = await findLandedBranches(repoCwd, baseRef, protect);
  const stillLanded = new Map(fresh.landed.map((b) => [b.name, b]));
  for (const name of names) {
    const branch = stillLanded.get(name);
    if (!branch) {
      failed.set(name, 'no longer landed — it has commits the base does not');
      continue;
    }
    if (branch.worktree) {
      failed.set(name, `checked out at ${branch.worktree}`);
      continue;
    }
    try {
      await git(repoCwd, ['branch', '-D', name]);
      deleted.push(name);
    } catch (err) {
      failed.set(name, err instanceof Error ? err.message : String(err));
    }
  }
  return { deleted, failed };
}
