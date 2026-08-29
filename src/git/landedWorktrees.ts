import { gitOk } from './exec';
import {
  DEFAULT_EXPENDABLE_IGNORED,
  splitIgnored,
  summarizeIgnored,
} from './expendableIgnored';
import { ignoredFiles, isWorktreeDirty } from './plumbing';
import { listWorktreeAdmin, removeWorktree } from './worktreeAdmin';
import type { DiscoveredWorktree } from './discovery';

/**
 * Clearing away the checkouts of branches that have already landed.
 *
 * A landed branch's commits are provably in the base, so its checkout is
 * disk with nothing on it — but until now nothing removed it and nothing
 * SAID it was still there: the row moved to the Landed group, where it
 * looked exactly like a branch that was only a ref. Crust you cannot see
 * is crust nobody clears.
 *
 * So two halves, and the second is why the first is safe to run
 * unattended:
 *
 *  - a checkout that is provably landed and provably empty of anything
 *    else is removed on sight (`git worktree remove`, no force, ref kept);
 *  - anything that is NOT provably empty is left exactly as it is, and the
 *    reason is carried back to the row, which stays under Working — the
 *    group that means "there is a folder on disk" — with the blocker as
 *    its badge.
 *
 * Nothing here deletes a branch. Refs are Prune Landed Branches' job,
 * where the landing is proven three ways and confirmed by a human; this
 * only ever gives back a folder that `git worktree add` would recreate.
 */

/** Why a landed checkout was left alone. Ordered most-alarming first. */
export type LandedBlocker =
  | 'dirty'
  | 'ignored'
  | 'open'
  | 'busy'
  | 'locked'
  | 'main'
  | 'detached'
  | 'failed'
  /** Removable, but automatic removal is switched off. */
  | 'off';

export interface LandedWorktreeFacts {
  /** Uncommitted changes, staged or not, tracked or untracked. */
  dirty: boolean;
  /**
   * Gitignored files present that are NOT derived. The dirty probe cannot
   * see them and `git worktree remove` takes them without complaint, so
   * they are the one thing an unattended removal could actually destroy —
   * a `.env`, a dump nobody has anywhere else. A `node_modules` or a
   * `dist` is not one of them (see `expendableIgnored.ts`): holding a
   * landed checkout hostage to a folder `npm install` recreates is how
   * this rule ends up protecting nothing and clearing nothing.
   */
  ignored: boolean;
  /** An editor is open on a file inside it — someone is working here. */
  open: boolean;
  /** A rebase or merge is paused in it; somebody's resolution is midway. */
  busy: boolean;
  locked: boolean;
  /** The main / root worktree, which git will not remove and we must not. */
  main: boolean;
  detached: boolean;
}

/**
 * May this landed checkout be removed without asking?
 *
 * Pure, and every blocker is a positive reason to stop rather than an
 * absence of permission — which is what makes the default answer "leave
 * it" whenever a probe could not run and the caller passes `true`.
 */
export function landedWorktreeVerdict(
  facts: LandedWorktreeFacts,
): { remove: true } | { remove: false; blocker: LandedBlocker } {
  // Order matters only for what the row says: the first blocker found is
  // the one shown, so the most SPECIFIC comes first. `busy` outranks
  // `dirty` because a paused merge is dirty by definition — conflict
  // markers in the tree — and "rebase/merge paused" is the fact that
  // tells someone what to do next.
  if (facts.main) return { remove: false, blocker: 'main' };
  if (facts.busy) return { remove: false, blocker: 'busy' };
  if (facts.dirty) return { remove: false, blocker: 'dirty' };
  if (facts.ignored) return { remove: false, blocker: 'ignored' };
  if (facts.open) return { remove: false, blocker: 'open' };
  if (facts.locked) return { remove: false, blocker: 'locked' };
  // A detached checkout has no branch, so it can never have landed; being
  // here at all means the caller matched it by path.
  if (facts.detached) return { remove: false, blocker: 'detached' };
  return { remove: true };
}

/** What the row says when a landed checkout could not be cleared. */
export function describeBlocker(blocker: LandedBlocker): string {
  switch (blocker) {
    case 'dirty':
      return 'landed · uncommitted changes';
    case 'ignored':
      return 'landed · ignored files';
    case 'open':
      return 'landed · open in an editor';
    case 'busy':
      return 'landed · rebase/merge paused';
    case 'locked':
      return 'landed · locked';
    case 'main':
      return 'landed';
    case 'detached':
      return 'landed · detached';
    case 'failed':
      return 'landed · removal failed';
    case 'off':
      return 'landed · on disk';
  }
}

/** The longer form, for the tooltip. */
export function explainBlocker(blocker: LandedBlocker, branch: string): string {
  const landed = `${branch} has landed in the base — its commits are already there, so this checkout holds nothing of its own.`;
  switch (blocker) {
    case 'dirty':
      return `${landed}\nIt was kept because the working tree has uncommitted changes. Commit them somewhere they belong, or discard them, and the folder is cleared automatically.`;
    case 'ignored':
      return `${landed}\nIt was kept because it holds gitignored files that are not derived — a .env, a local dump: the one thing removing the folder would actually destroy. Build output and installs (node_modules, dist) do not keep a folder; anything else does. Delete Worktree removes it and names them first.`;
    case 'open':
      return `${landed}\nIt was kept because a file inside it is open in an editor. Close it and the folder is cleared automatically.`;
    case 'busy':
      return `${landed}\nIt was kept because a rebase or merge is paused here. Finish or abort it first — a paused resolution is somebody's work in progress.`;
    case 'locked':
      return `${landed}\nIt was kept because the worktree is locked (git worktree lock). Unlock it if the lock has outlived its reason.`;
    case 'main':
      return `${landed}\nThis is the main / root checkout, which is never removed.`;
    case 'detached':
      return `${landed}\nThe checkout is detached, so it has no branch to be landed.`;
    case 'failed':
      return `${landed}\nRemoving the folder was attempted and failed; see Output → Git Workflow. Delete Worktree reports the reason.`;
    case 'off':
      return `${landed}\nThe folder can be removed safely — automatic removal is off (worktreeCompare.autoRemoveLandedWorktrees). Delete Worktree clears it.`;
  }
}

export interface LandedSweepResult {
  /** Paths whose folders were removed. */
  removed: { path: string; branch: string }[];
  /** Still on disk, with the reason, keyed by checkout path. */
  blocked: Map<string, { branch: string; blocker: LandedBlocker }>;
}

/**
 * Probe and clear every landed checkout in one pass.
 *
 * `isOpen` is supplied by the caller because it is the one fact that is not
 * a git question — the view layer knows which files are open, and keeping
 * that out of here is what leaves the decision unit-testable.
 */
export async function sweepLandedWorktrees(
  worktrees: readonly DiscoveredWorktree[],
  landed: ReadonlySet<string>,
  options: {
    /** Off: probe and report blockers, remove nothing. */
    remove: boolean;
    isOpen: (path: string) => boolean;
    /** Ignored paths a removal may take (default: the derived-file list). */
    expendable?: readonly string[];
    log?: (line: string) => void;
  },
): Promise<LandedSweepResult> {
  const result: LandedSweepResult = { removed: [], blocked: new Map() };
  const candidates = worktrees.filter(
    (wt) => !wt.detached && landed.has(wt.branch),
  );
  if (candidates.length === 0) return result;

  for (const wt of candidates) {
    const { facts, expendable } = await landedFacts(
      wt,
      options.isOpen(wt.path),
      options.expendable ?? DEFAULT_EXPENDABLE_IGNORED,
    );
    const verdict = landedWorktreeVerdict(facts);
    if (!verdict.remove) {
      result.blocked.set(wt.path, {
        branch: wt.branch,
        blocker: verdict.blocker,
      });
      continue;
    }
    if (!options.remove) {
      // Reporting mode: it WOULD have been removed, and the row still has
      // to say the folder is on disk — that visibility is the half of this
      // feature the setting does not turn off.
      result.blocked.set(wt.path, { branch: wt.branch, blocker: 'off' });
      continue;
    }
    // No force: git refuses on anything the probes missed, and a refusal
    // is a blocker to report rather than an obstacle to overcome.
    const removal = await removeWorktree(wt.path, {});
    if (removal.ok) {
      result.removed.push({ path: wt.path, branch: wt.branch });
      // Naming the derived files it took is the whole safety of taking
      // them unattended: a wrong pattern shows up in the log as a folder
      // somebody wanted, rather than as nothing at all.
      const alsoTook =
        expendable.length > 0
          ? `; also deleted ignored ${summarizeIgnored(expendable)}`
          : '';
      options.log?.(
        `Removed landed checkout ${wt.path} (${wt.branch} is in the base; branch ref kept${alsoTook})`,
      );
      continue;
    }
    const blocker: LandedBlocker =
      removal.code === 'dirty'
        ? 'dirty'
        : removal.code === 'locked'
          ? 'locked'
          : removal.code === 'main'
            ? 'main'
            : 'failed';
    result.blocked.set(wt.path, { branch: wt.branch, blocker });
    options.log?.(
      `Landed checkout ${wt.path} kept (${blocker}): ${removal.message ?? ''}`,
    );
  }
  return result;
}

/** Every git-side fact the verdict needs, probed fresh. */
async function landedFacts(
  wt: DiscoveredWorktree,
  open: boolean,
  expendablePatterns: readonly string[],
): Promise<{ facts: LandedWorktreeFacts; expendable: string[] }> {
  // Fresh probes: a cached isDirty is a snapshot, and this decides whether
  // a directory is deleted.
  const dirty = await isWorktreeDirty(wt.path).catch(() => true);
  // A probe that could not run must not be read as "nothing here": the
  // fallback is a full stop, which is why it is `kept`, not `expendable`.
  const split = await ignoredFiles(wt.path)
    .then((files) => splitIgnored(files, expendablePatterns))
    .catch(() => ({ expendable: [], kept: ['<probe failed>'] }));
  const busy = await mergeOrRebaseInProgress(wt.path);
  let locked = Boolean(wt.locked);
  let main = Boolean(wt.isRootCheckout || wt.isMainWorktree);
  try {
    const admin = (await listWorktreeAdmin(wt.path)).get(wt.path);
    if (admin) {
      locked = locked || Boolean(admin.locked);
      main = main || Boolean(admin.isMain);
    }
  } catch {
    // The discovery flags stand; a probe that could not run adds nothing.
  }
  return {
    facts: {
      dirty,
      ignored: split.kept.length > 0,
      open,
      busy,
      locked,
      main,
      detached: wt.detached,
    },
    expendable: split.expendable,
  };
}

/** A paused rebase or merge, by the state files git leaves behind. */
async function mergeOrRebaseInProgress(dir: string): Promise<boolean> {
  for (const ref of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
    if (await gitOk(dir, ['rev-parse', '-q', '--verify', ref])) return true;
  }
  return false;
}
