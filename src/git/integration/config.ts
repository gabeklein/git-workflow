import * as vscode from 'vscode';

/**
 * Subject prefix of the ephemeral wip snapshot commits rebuilds overlay.
 * Shared so the stray-commit scan can tell an extension-made snapshot
 * apart from work a person actually committed on the integration branch.
 */
export const WIP_SUBJECT = 'wip(gw):';

export function integrationBranch(): string {
  const template =
    vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<string>('integrationBranch', 'integration/{base}')
      .trim() || 'integration/{base}';
  // {base} → short base name (origin/main → main)
  return template.replace(
    '{base}',
    integrationBaseRef().replace(/^origin\//, ''),
  );
}

/**
 * Whether work committed directly on the integration checkout is moved to
 * the base automatically. Off leaves the rebuild refusing (the commits are
 * still safe) until Absorb is run by hand.
 */
export function isIntegrationAbsorbEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<boolean>('integrationAbsorbStrays', true);
}

/**
 * Whether a pre-commit hook refuses commits made on the integration branch.
 * The branch is derived — rebuilds recreate it — so a commit there has no
 * home, and absorb (the rescue) can only ever aim at the base, which is the
 * wrong destination when the work belonged to a lane. Off leaves the older
 * behaviour: commit freely, and let the rebuild's unique guard catch it.
 */
export function isCommitGuardEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<boolean>('integrationCommitGuard', true);
}

/**
 * Whether a landed, clean, unlocked worktree is removed on Delete Worktree
 * without the confirmation modal. Its COMMITS are provably safe; ignored
 * files in the checkout are not, which is why this can be turned off.
 */
export function isQuickDeleteLandedEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<boolean>('quickDeleteLandedWorktrees', true);
}

export function isIntegrationAutoRebuildEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<boolean>('integrationAutoRebuild', true);
}

/**
 * Base ref for integration rebuilds: integrationBaseRef when set,
 * else defaultBaseRef. Kept separate so changing the integration base
 * (header context menu) does not affect compare-base fallbacks.
 */
export function integrationBaseRef(): string {
  const config = vscode.workspace.getConfiguration('worktreeCompare');
  const dedicated = config.get<string>('integrationBaseRef', '').trim();
  return dedicated || config.get<string>('defaultBaseRef', 'main');
}

export type AutoResolveMode = 'off' | 'whitespace' | 'best-effort';

/**
 * How far a lane merge may auto-resolve clashes. Non-overlapping hunks in
 * the same file always merge — git does that by default. Beyond that:
 * 'whitespace' also resolves formatting-only clashes plus everything the
 * LOSSLESS resolver can prove safe (union of insert-only sides, linewise
 * 3-way); 'best-effort' (default — integration is a preview of unlanded
 * work) additionally resolves remaining text clashes toward the incoming
 * lane, TAGGED on the lane row so dropped hunks are never silent.
 * 'lane-wins' is accepted as a legacy alias for 'best-effort'.
 */
export function integrationAutoResolve(): AutoResolveMode {
  const v = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<string>('integrationAutoResolve', 'best-effort');
  if (v === 'off' || v === 'whitespace') {
    return v;
  }
  return 'best-effort';
}

export function autoResolveArgs(): string[] {
  // Never -X theirs here: silent hunk-dropping during the merge would
  // bypass the resolver's lossless rules AND its lossy tagging. The
  // theirs fallback lives in resolveConflictedTree, per file, reported.
  return integrationAutoResolve() === 'off'
    ? []
    : ['-X', 'ignore-space-change'];
}

/** What the per-file conflict resolver may do after a conflicted merge. */
export function conflictResolverMode(): 'none' | 'lossless' | 'full' {
  switch (integrationAutoResolve()) {
    case 'off':
      return 'none';
    case 'whitespace':
      return 'lossless';
    default:
      return 'full';
  }
}

export type CatchUpStrategy = 'auto' | 'rebase' | 'merge';

/**
 * How Catch Up with Base brings a lane up to date. 'auto': rebase
 * unpushed lanes (their history is still private), merge the base into
 * pushed ones (no force-push, PR review anchors survive — squash landings
 * erase the merge bubbles anyway).
 */
export function catchUpStrategy(): CatchUpStrategy {
  const v = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<string>('catchUpStrategy', 'auto');
  return v === 'rebase' || v === 'merge' ? v : 'auto';
}

export type AutoRebaseMode = 'off' | 'local-only';

/**
 * Proactive catch-up: automatically bring lanes up to date as the base
 * moves. 'local-only' touches ONLY linked worktrees that are clean,
 * behind, conflict-free, and unpushed — pushed branches are never
 * rewritten automatically. Default off: moving a user's branch is a side
 * effect they must opt into.
 */
export function autoRebaseLanes(): AutoRebaseMode {
  const v = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<string>('autoRebaseLanes', 'off');
  return v === 'local-only' ? v : 'off';
}

/** Branches that must never be applied as a lane. */
export function isLaneBranch(branch: string, baseRef: string): boolean {
  if (!branch || branch === 'HEAD' || branch === 'unknown') {
    return false;
  }
  const blocked = new Set([
    'main',
    'master',
    integrationBranch(),
    baseRef.replace(/^origin\//, ''),
  ]);
  return !blocked.has(branch) && !branch.startsWith('gitbutler/');
}
