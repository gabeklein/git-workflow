import type { DiscoveredWorktree } from '../discovery/scanner';
import type { BranchInfo } from '../git/branches';

/**
 * Row planning for the Lanes panel — pure, so the grouping rules are
 * testable without a workbench.
 *
 * The model: a worktree is an ACTIVITY STATUS of a branch, not a separate
 * kind of thing. So the groups are a LADDER, not four categories — each
 * rung is defined by falling through the one above it:
 *
 *   Landed   its work is in the base (and usually its remote is gone)
 *   Working  has a checkout on disk
 *   Local    has a local ref, no checkout — may also exist on the remote,
 *            which shows as sync badges rather than a second row
 *   Remote   no local ref at all
 *
 * Evaluation runs top-down and first match wins, so a branch appears in
 * exactly one group. Note that Landed is evaluated FIRST and displayed
 * LAST: a landed branch that still has a checkout has to reach the Landed
 * group, or the cleanup affordance that group exists for never sees it.
 */

export interface LandedLane {
  branch: string;
  /** Present when the landed branch still has a checkout to clean up. */
  worktree?: DiscoveredWorktree;
}

interface LanesPlan {
  /** Checkouts, root first, then most recently committed. */
  working: DiscoveredWorktree[];
  /** Local branches with no checkout of their own. */
  local: BranchInfo[];
  /** Branches that exist only on the remote. */
  remote: BranchInfo[];
  /** Done: merged into the base, ready to prune. Displayed last. */
  landed: LandedLane[];
  /** Rows beyond the cap, reported rather than silently dropped. */
  hiddenLocal: number;
  hiddenRemote: number;
}

export interface LanesPlanInput {
  worktrees: DiscoveredWorktree[];
  branches: BranchInfo[];
  /** Branch names with an open PR — kept visible in the remote group. */
  prHeads?: ReadonlySet<string>;
  /** The derived integration branch, which is never a row of its own here. */
  integrationBranch?: string;
  /** Checkout the integration branch occupies, if any. */
  integrationPath?: string;
  /**
   * Branches whose work is CONFIRMED in the base. Confirmed, not merely
   * absent from the remote: a remote branch deleted without merging looks
   * identical from the ref alone, and offering that for deletion is how
   * unmerged work disappears. The caller decides — see landedProbe.
   */
  landed?: ReadonlySet<string>;
  limit?: number;
}

const DEFAULT_LIMIT = 50;

/** Recency for a checkout, taken from its branch's tip date. */
function checkoutDate(
  wt: DiscoveredWorktree,
  dates: Map<string, number>,
): number {
  return wt.detached ? 0 : (dates.get(wt.branch) ?? 0);
}

export function planLaneRows(input: LanesPlanInput): LanesPlan {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const dates = new Map(input.branches.map((b) => [b.name, b.committerDate]));

  // The integration checkout is derived state, not someone's work — it is
  // the panel's subject, not a row in its list.
  const landedNames = input.landed ?? new Set<string>();
  const listed = input.worktrees.filter(
    (wt) => wt.path !== input.integrationPath,
  );

  // Rung 1, evaluated first: anything landed leaves the ladder here, even
  // when it still has a checkout. A detached checkout has no branch and so
  // can never be landed.
  const landedCheckouts = listed.filter(
    (wt) => !wt.detached && landedNames.has(wt.branch),
  );
  const checkouts = listed.filter((wt) => !landedCheckouts.includes(wt));
  const ordered = checkouts.slice().sort((a, b) => {
    // Root first, always: it is the anchor the others were cut from.
    const rootA = a.isRootCheckout || a.isMainWorktree ? 1 : 0;
    const rootB = b.isRootCheckout || b.isMainWorktree ? 1 : 0;
    if (rootA !== rootB) return rootB - rootA;
    // Detached checkouts have no branch to date them — they sink below the
    // named ones rather than sorting as if they were ancient.
    if (a.detached !== b.detached) return a.detached ? 1 : -1;
    const byDate = checkoutDate(b, dates) - checkoutDate(a, dates);
    return byDate !== 0 ? byDate : a.path.localeCompare(b.path);
  });

  const claimed = new Set(
    checkouts.filter((w) => !w.detached).map((w) => w.branch),
  );
  const rest = input.branches.filter(
    (b) =>
      !claimed.has(b.name) &&
      b.name !== input.integrationBranch &&
      !landedNames.has(b.name),
  );

  // Landed branches with no checkout of their own, newest first like the
  // rest; the ones that DO have a checkout carry it, so the row can offer
  // to remove the folder as well as the ref.
  const landedRows: LandedLane[] = [
    ...landedCheckouts.map((wt) => ({ branch: wt.branch, worktree: wt })),
    ...input.branches
      .filter(
        (b) =>
          landedNames.has(b.name) &&
          b.hasLocalRef &&
          !landedCheckouts.some((wt) => wt.branch === b.name),
      )
      .map((b) => ({ branch: b.name })),
  ];

  // listBranches already sorts by committerdate desc, so slicing preserves
  // recency without a second sort.
  const local = rest.filter((b) => b.hasLocalRef);
  const remoteOnly = rest.filter((b) => !b.hasLocalRef);
  // A branch with an open PR earns its place in the remote group even when
  // it is old enough to fall past the cap.
  const prHeads = input.prHeads ?? new Set<string>();
  const remoteRanked = [
    ...remoteOnly.filter((b) => prHeads.has(b.name)),
    ...remoteOnly.filter((b) => !prHeads.has(b.name)),
  ];

  return {
    working: ordered,
    local: local.slice(0, limit),
    remote: remoteRanked.slice(0, limit),
    landed: landedRows,
    hiddenLocal: Math.max(0, local.length - limit),
    hiddenRemote: Math.max(0, remoteRanked.length - limit),
  };
}

/** Label for a checkout row — detached ones are identified by sha. */
export function checkoutLabel(
  wt: DiscoveredWorktree,
  shortSha?: string,
): string {
  return wt.detached ? `Detached (${shortSha ?? wt.branch})` : wt.branch;
}

/**
 * Row order for the lanes under Preview: the stored order first, then
 * anything not in it, sorted.
 *
 * ONE list, whether or not a lane is checked. Order used to come from the
 * applied file, which meant checking a lane appended it and the row jumped
 * to the end under the user's cursor — a toggle silently restating where a
 * lane merges. Order and membership are separate files now, so the row
 * stays put and only dragging moves it.
 *
 * Merge order is this list filtered to the applied ones, so an unchecked
 * lane still holds its place and reclaims it when checked.
 */
export function orderLaneRows(order: string[], known: string[]): string[] {
  const placed = order.filter((l) => known.includes(l));
  const seen = new Set(placed);
  const rest = [...new Set(known)].filter((l) => !seen.has(l)).sort();
  return [...placed, ...rest];
}
