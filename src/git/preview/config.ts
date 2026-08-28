import * as vscode from 'vscode';

/**
 * Subject prefix of the ephemeral wip snapshot commits rebuilds overlay.
 * Shared so the stray-commit scan can tell an extension-made snapshot
 * apart from work a person actually committed on the preview branch.
 */
export const WIP_SUBJECT = 'wip(gw):';

/**
 * Which preview is being talked about — there is exactly one, and this is
 * it, resolved from the workspace settings.
 *
 * The type exists even at cardinality one because the git layer must not
 * read the setting itself: it used to answer "is this THE preview branch?"
 * by calling previewBranch() from 25 call sites, which is what made the
 * layer untestable without a workspace. Views and commands resolve the
 * preview once here and pass it down.
 */
export interface Preview {
  /** The derived preview branch, e.g. `preview/main`. */
  readonly branch: string;
  /** What it is built from, e.g. `origin/main`. */
  readonly baseRef: string;
}

/** The one place the preview settings are read. */
export function currentPreview(): Preview {
  return { branch: previewBranch(), baseRef: previewBaseRef() };
}

export function previewBranch(): string {
  const template =
    vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<string>('previewBranch', 'preview/{base}')
      .trim() || 'preview/{base}';
  // {base} → short base name (origin/main → main)
  return template.replace(
    '{base}',
    previewBaseRef().replace(/^origin\//, ''),
  );
}

/**
 * Whether work committed directly on the preview checkout is moved to
 * the base automatically. Off leaves the rebuild refusing (the commits are
 * still safe) until Absorb is run by hand.
 */
export function isPreviewAbsorbEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<boolean>('previewAbsorbStrays', true);
}

/**
 * Whether a pre-commit hook refuses commits made on the preview branch.
 * The branch is derived — rebuilds recreate it — so a commit there has no
 * home, and absorb (the rescue) can only ever aim at the base, which is the
 * wrong destination when the work belonged to a lane. Off leaves the older
 * behaviour: commit freely, and let the rebuild's unique guard catch it.
 */
export function isCommitGuardEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<boolean>('previewCommitGuard', true);
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

/**
 * Whether the checkout of a landed branch is removed as soon as it is
 * provably empty of anything else — clean, unlocked, no ignored files, no
 * paused merge, nothing open in an editor. The branch REF is never touched
 * (that is Prune Landed Branches), so this only ever gives back a folder
 * `git worktree add` would recreate.
 *
 * Off keeps every folder and still badges the row `landed · on disk`: the
 * visibility is the bug being fixed, and it is not what the switch is for.
 */
/**
 * Whether stale remote-tracking refs are pruned in the background.
 *
 * Nothing else in git removes them: every fetch here is a targeted
 * refspec and `git pull` does not prune, so a branch deleted on the remote
 * — what a merged PR does by default — leaves `origin/<name>` behind
 * forever and the Remote group lists a branch that does not exist.
 * Pruning drops only the cache entry, and the next fetch restores it if
 * the branch is real.
 */
export function isPruneRemoteRefsEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<boolean>('pruneRemoteRefs', true);
}

export function isAutoRemoveLandedEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<boolean>('autoRemoveLandedWorktrees', true);
}

export function isPreviewAutoRebuildEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<boolean>('previewAutoRebuild', true);
}

/**
 * Base ref for preview rebuilds: previewBaseRef when set,
 * else defaultBaseRef. Kept separate so changing the preview base
 * (header context menu) does not affect compare-base fallbacks.
 */
export function previewBaseRef(): string {
  const config = vscode.workspace.getConfiguration('worktreeCompare');
  const dedicated = config.get<string>('previewBaseRef', '').trim();
  return dedicated || config.get<string>('defaultBaseRef', 'main');
}

type AutoResolveMode = 'off' | 'whitespace' | 'best-effort';

/**
 * How far a lane merge may auto-resolve clashes. Non-overlapping hunks in
 * the same file always merge — git does that by default. Beyond that:
 * 'whitespace' also resolves formatting-only clashes plus everything the
 * LOSSLESS resolver can prove safe (union of insert-only sides, linewise
 * 3-way); 'best-effort' (default — preview is a preview of unlanded
 * work) additionally resolves remaining text clashes toward the incoming
 * lane, TAGGED on the lane row so dropped hunks are never silent.
 * 'lane-wins' is accepted as a legacy alias for 'best-effort'.
 */
function previewAutoResolve(): AutoResolveMode {
  const v = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<string>('previewAutoResolve', 'best-effort');
  if (v === 'off' || v === 'whitespace') return v;
  return 'best-effort';
}

export function autoResolveArgs(): string[] {
  // Never -X theirs here: silent hunk-dropping during the merge would
  // bypass the resolver's lossless rules AND its lossy tagging. The
  // theirs fallback lives in resolveConflictedTree, per file, reported.
  return previewAutoResolve() === 'off'
    ? []
    : ['-X', 'ignore-space-change'];
}

/** What the per-file conflict resolver may do after a conflicted merge. */
export function conflictResolverMode(): 'none' | 'lossless' | 'full' {
  switch (previewAutoResolve()) {
    case 'off':
      return 'none';
    case 'whitespace':
      return 'lossless';
    default:
      return 'full';
  }
}

type CatchUpStrategy = 'auto' | 'rebase' | 'merge';

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

type AutoRebaseMode = 'off' | 'local-only';

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
  if (!branch || branch === 'HEAD' || branch === 'unknown') return false;
  const blocked = new Set([
    'main',
    'master',
    // The preview branch is never a lane. Read here rather than passed:
    // this module is where the setting lives, and there is exactly one
    // preview to ask about.
    previewBranch(),
    baseRef.replace(/^origin\//, ''),
  ]);
  return !blocked.has(branch) && !branch.startsWith('gitbutler/');
}
