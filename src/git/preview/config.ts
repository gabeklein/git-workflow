import * as vscode from 'vscode';
import type { Preview } from './identity';

/**
 * Subject prefix of the ephemeral wip snapshot commits rebuilds overlay.
 * Shared so the stray-commit scan can tell an extension-made snapshot
 * apart from work a person actually committed on the preview branch.
 */
export const WIP_SUBJECT = 'wip(gw):';

/**
 * The configured preview for this workspace.
 *
 * The one place the setting is read. Below the view layer nothing consults
 * it — see identity.ts for why — so this exists to be resolved once and
 * passed down.
 */
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
