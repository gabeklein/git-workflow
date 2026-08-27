import * as os from 'node:os';
import * as path from 'node:path';

export function isPathInside(fsPath: string, root: string): boolean {
  const resolved = path.resolve(fsPath);
  const rootResolved = path.resolve(root);
  return (
    resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)
  );
}

/**
 * Skip hot-follow for paths that churn hard and are not useful for SCM UI.
 * Only segments INSIDE the worktree count — a repo living under /tmp (or
 * below a parent named build/out/…) must not lose reactivity wholesale.
 */
export function shouldIgnoreHotFollowPath(
  fsPath: string,
  worktreeRoot: string,
): boolean {
  const rel = path.relative(path.resolve(worktreeRoot), path.resolve(fsPath));
  const parts = rel.split(/[/\\]/);
  for (const part of parts) {
    if (
      part === 'node_modules' ||
      part === '.git' ||
      part === 'dist' ||
      part === 'out' ||
      part === 'build' ||
      part === '.next' ||
      part === 'coverage' ||
      part === '.turbo' ||
      part === '.cache' ||
      part === 'tmp' ||
      part === '.DS_Store'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Shortest honest way to say where a checkout is, relative to the window.
 *
 * A worktree is usually a sibling of the folder you have open, sometimes
 * nested inside it, and occasionally somewhere else entirely. An absolute
 * path answers all three but buries the part that distinguishes them, so
 * this offers every true form — `.` for the workspace root, `x` inside it,
 * `../x` beside it, `~/x` under home, absolute otherwise — and picks the
 * shortest. A bare relative path needs no `./`: nothing else in the list
 * looks like one, so the prefix only costs width.
 *
 * Shortest rather than a fixed preference order, because a preference gets
 * it wrong in both directions: two levels up followed by a deep descent
 * (`../../Users/you/Projects/thing`) is not "beside" anything, and is
 * plainly worse than `~/Projects/thing`, while a sibling really is better
 * as `../other` than as either alternative. Length is a good proxy for
 * which relationship is the informative one. Ties prefer the workspace
 * anchor, since that is the frame the user is actually looking at.
 */
export function describeLocation(
  fsPath: string,
  workspaceRoot?: string,
): string {
  const target = path.resolve(fsPath);
  const candidates: string[] = [];
  if (workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    if (target === root) {
      return '.';
    }
    const rel = path.relative(root, target);
    if (rel && !path.isAbsolute(rel)) {
      candidates.push(rel);
    }
  }
  const home = os.homedir();
  if (home && (target === home || target.startsWith(home + path.sep))) {
    const rel = path.relative(home, target);
    candidates.push(rel ? `~/${rel}` : '~');
  }
  candidates.push(target);
  return candidates.reduce((best, next) =>
    next.length < best.length ? next : best,
  );
}
