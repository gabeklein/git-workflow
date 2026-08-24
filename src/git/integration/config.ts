import * as vscode from 'vscode';

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

export type AutoResolveMode = 'off' | 'whitespace' | 'lane-wins';

/**
 * How far a lane merge may auto-resolve clashes. Non-overlapping hunks in
 * the same file always merge — git does that by default. This governs the
 * rest: 'whitespace' resolves formatting-only clashes; 'lane-wins' resolves
 * every text clash toward the incoming lane (covers adjacent-line edits,
 * at the cost of possibly dropping the other side's neighboring edit).
 */
export function integrationAutoResolve(): AutoResolveMode {
  const v = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<string>('integrationAutoResolve', 'whitespace');
  return v === 'off' || v === 'lane-wins' ? v : 'whitespace';
}

export function autoResolveArgs(): string[] {
  switch (integrationAutoResolve()) {
    case 'lane-wins':
      // theirs implies whitespace clashes resolve too
      return ['-X', 'theirs', '-X', 'ignore-space-change'];
    case 'whitespace':
      return ['-X', 'ignore-space-change'];
    default:
      return [];
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
