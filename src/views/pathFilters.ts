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
