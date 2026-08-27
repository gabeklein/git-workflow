import type { DiscoveredWorktree } from '../discovery/scanner';
import type { BranchInfo } from '../git/branches';

/**
 * Row planning for the Focus panel — pure, so the ordering and grouping
 * rules are testable without a workbench.
 *
 * The model: a worktree is an ACTIVITY STATUS of a branch, not a separate
 * kind of thing. So checkouts sort to the top as themselves, everything
 * else is a branch waiting to become one, and a branch never appears in
 * two places.
 */

export interface FocusPlan {
  /** Checkouts, root first, then most recently committed. */
  checkouts: DiscoveredWorktree[];
  /** Local branches with no checkout of their own. */
  branches: BranchInfo[];
  /** Branches that exist only on the remote. */
  remote: BranchInfo[];
  /** Local branches beyond the cap, reported rather than silently dropped. */
  hiddenBranches: number;
  hiddenRemote: number;
}

export interface FocusPlanInput {
  worktrees: DiscoveredWorktree[];
  branches: BranchInfo[];
  /** Branch names with an open PR — kept visible in the remote group. */
  prHeads?: ReadonlySet<string>;
  /** The derived integration branch, which is never a row of its own here. */
  integrationBranch?: string;
  /** Checkout the integration branch occupies, if any. */
  integrationPath?: string;
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

export function planFocusRows(input: FocusPlanInput): FocusPlan {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const dates = new Map(input.branches.map((b) => [b.name, b.committerDate]));

  // The integration checkout is derived state, not someone's work — it is
  // the panel's subject, not a row in its list.
  const checkouts = input.worktrees.filter(
    (wt) => wt.path !== input.integrationPath,
  );
  const ordered = checkouts.slice().sort((a, b) => {
    // Root first, always: it is the anchor the others were cut from.
    const rootA = a.isRootCheckout || a.isMainWorktree ? 1 : 0;
    const rootB = b.isRootCheckout || b.isMainWorktree ? 1 : 0;
    if (rootA !== rootB) {
      return rootB - rootA;
    }
    // Detached checkouts have no branch to date them — they sink below the
    // named ones rather than sorting as if they were ancient.
    if (a.detached !== b.detached) {
      return a.detached ? 1 : -1;
    }
    const byDate = checkoutDate(b, dates) - checkoutDate(a, dates);
    return byDate !== 0 ? byDate : a.path.localeCompare(b.path);
  });

  const claimed = new Set(
    checkouts.filter((w) => !w.detached).map((w) => w.branch),
  );
  const rest = input.branches.filter(
    (b) => !claimed.has(b.name) && b.name !== input.integrationBranch,
  );

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
    checkouts: ordered,
    branches: local.slice(0, limit),
    remote: remoteRanked.slice(0, limit),
    hiddenBranches: Math.max(0, local.length - limit),
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
 * Row order for the lanes under Integration: applied lanes first, in the
 * order they will actually be merged, then the rest as a sorted set.
 *
 * Merge order is the order lanes were included, and it decides conflict
 * outcomes — union inserts land in merge order, and best-effort resolves
 * same-line clashes toward the incoming lane. Rendering that list sorted
 * therefore shows an order the rebuild does not use, on exactly the
 * question where order matters. Unapplied candidates have no position in
 * the chain, so for them a sorted list is the honest presentation.
 */
export function orderLaneRows(
  applied: string[],
  others: string[],
): string[] {
  const seen = new Set(applied);
  const rest = [...new Set(others)].filter((l) => !seen.has(l)).sort();
  return [...applied, ...rest];
}
