import * as path from 'node:path';
import { git, gitOk } from './exec';

export interface WorktreeInfo {
  /** Absolute path to the worktree checkout */
  path: string;
  /** Display name (directory basename) */
  name: string;
  /** Current branch, or detached HEAD short sha */
  branch: string;
  /** Whether HEAD is detached */
  detached: boolean;
  /** Absolute path to the main worktree (common root), if known */
  mainWorktreePath?: string;
}

/** Well-known integration-branch names used when inferring a compare base. */
const INTEGRATION_NAMES = [
  'main',
  'master',
  'staging',
  'develop',
  'development',
  'trunk',
  'release',
];

export async function isGitWorktree(dir: string): Promise<boolean> {
  return gitOk(dir, ['rev-parse', '--is-inside-work-tree']);
}

export async function inspectWorktree(dir: string): Promise<WorktreeInfo | undefined> {
  if (!(await isGitWorktree(dir))) {
    return undefined;
  }

  const name = path.basename(dir);
  let branch = 'HEAD';
  let detached = false;

  try {
    const symbolic = (await git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])).trim();
    if (symbolic) {
      branch = symbolic;
    }
  } catch {
    detached = true;
    try {
      branch = (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
    } catch {
      branch = 'unknown';
    }
  }

  let mainWorktreePath: string | undefined;
  try {
    const commonDir = (
      await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
    if (commonDir.endsWith(`${path.sep}.git`) || commonDir.endsWith('/.git')) {
      mainWorktreePath = path.dirname(commonDir);
    } else if (commonDir.endsWith('.git')) {
      mainWorktreePath = path.dirname(commonDir);
    }
  } catch {
    // optional metadata
  }

  return {
    path: dir,
    name,
    branch,
    detached,
    mainWorktreePath,
  };
}

async function refResolves(worktreePath: string, ref: string): Promise<boolean> {
  if (!ref) {
    return false;
  }
  return gitOk(worktreePath, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

/**
 * Prefer the remote-tracking counterpart when the local name may be stale.
 * `staging` → `origin/staging` when that ref exists.
 */
export async function preferRemoteTrackingRef(
  worktreePath: string,
  ref: string,
): Promise<string> {
  const trimmed = ref.trim();
  if (!trimmed || trimmed === 'HEAD' || trimmed.includes('..')) {
    return trimmed;
  }
  // Already remote-tracking style or full ref
  if (trimmed.startsWith('refs/') || trimmed.includes('/')) {
    return trimmed;
  }
  for (const remote of ['origin', 'upstream']) {
    const candidate = `${remote}/${trimmed}`;
    if (await refResolves(worktreePath, candidate)) {
      return candidate;
    }
  }
  return trimmed;
}

/**
 * Parse branch/HEAD reflog for where the branch started:
 *   `branch: Created from origin/staging`
 *   `checkout: moving from origin/staging to fix/foo`
 */
async function baseFromReflog(
  worktreePath: string,
  branch: string,
): Promise<string | undefined> {
  if (!branch || branch === 'HEAD' || branch === 'unknown') {
    return undefined;
  }

  const trySource = async (
    sourceRaw: string,
    line: string,
  ): Promise<string | undefined> => {
    let source = sourceRaw.trim().replace(/[.,;]+$/, '');
    if (!source) {
      return undefined;
    }
    if (source === 'HEAD') {
      const hashMatch = line.match(/^([0-9a-f]{7,40})\s/i);
      if (hashMatch?.[1]) {
        return nameIntegrationRefAt(worktreePath, hashMatch[1]);
      }
      return undefined;
    }
    if (source === branch || source.endsWith(`/${branch}`)) {
      return undefined;
    }
    if (await refResolves(worktreePath, source)) {
      return preferRemoteTrackingRef(worktreePath, source);
    }
    return undefined;
  };

  const scanLines = async (out: string): Promise<string | undefined> => {
    const lines = out.split('\n').filter((l) => l.trim());
    // Oldest first: creation / first checkout is the best signal
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] ?? '';
      const created = line.match(/Created from\s+(.+?)\s*$/i);
      if (created?.[1]) {
        const hit = await trySource(created[1], line);
        if (hit) {
          return hit;
        }
      }
      const checkout = line.match(
        /checkout:\s+moving from\s+(.+?)\s+to\s+(\S+)\s*$/i,
      );
      if (checkout?.[1] && checkout[2]) {
        const to = checkout[2].trim();
        if (to === branch || to === 'HEAD') {
          const hit = await trySource(checkout[1], line);
          if (hit) {
            return hit;
          }
        }
      }
    }
    return undefined;
  };

  try {
    const branchLog = await git(worktreePath, [
      'reflog',
      'show',
      '--date=unix',
      branch,
    ]);
    const fromBranch = await scanLines(branchLog);
    if (fromBranch) {
      return fromBranch;
    }
  } catch {
    // no branch reflog
  }

  try {
    const headLog = await git(worktreePath, [
      'reflog',
      'show',
      '--date=unix',
      'HEAD',
      '-n',
      '30',
    ]);
    return await scanLines(headLog);
  } catch {
    return undefined;
  }
}

/** If commit is exactly an integration branch tip, return that ref name. */
async function nameIntegrationRefAt(
  worktreePath: string,
  commit: string,
): Promise<string | undefined> {
  for (const ref of integrationCandidates()) {
    if (!(await refResolves(worktreePath, ref))) {
      continue;
    }
    try {
      const tip = (await git(worktreePath, ['rev-parse', ref])).trim();
      const target = (await git(worktreePath, ['rev-parse', commit])).trim();
      if (tip === target) {
        return ref;
      }
    } catch {
      // skip
    }
  }
  return undefined;
}

function integrationCandidates(extra?: string): string[] {
  const names = [...INTEGRATION_NAMES];
  if (extra && !names.includes(extra)) {
    names.unshift(extra);
  }
  const refs: string[] = [];
  for (const n of names) {
    // Prefer remote tips first — local integration branches are often stale
    refs.push(`origin/${n}`, n);
  }
  return refs;
}

/**
 * VS Code / GitHub PR extensions often stash the PR base:
 *   branch.<name>.vscode-merge-base = origin/staging
 */
async function baseFromBranchConfig(
  worktreePath: string,
  branch: string,
): Promise<string | undefined> {
  if (!branch || branch === 'HEAD' || branch === 'unknown') {
    return undefined;
  }
  const keys = [
    `branch.${branch}.vscode-merge-base`,
    `branch.${branch}.merge-base`,
    `branch.${branch}.gh-merge-base`,
  ];
  for (const key of keys) {
    try {
      const value = (await git(worktreePath, ['config', '--get', key])).trim();
      if (value && (await refResolves(worktreePath, value))) {
        return preferRemoteTrackingRef(worktreePath, value);
      }
    } catch {
      // unset
    }
  }
  return undefined;
}

/**
 * Among known integration refs, pick the closest ancestor of HEAD
 * (fewest commits in base..HEAD). Prefers remote-tracking names.
 */
async function baseFromClosestAncestor(
  worktreePath: string,
  defaultBaseRef: string,
): Promise<string | undefined> {
  let best: { ref: string; ahead: number } | undefined;

  for (const ref of integrationCandidates(defaultBaseRef)) {
    if (!(await refResolves(worktreePath, ref))) {
      continue;
    }
    const isAncestor = await gitOk(worktreePath, [
      'merge-base',
      '--is-ancestor',
      ref,
      'HEAD',
    ]);
    if (!isAncestor) {
      continue;
    }
    try {
      const aheadStr = (
        await git(worktreePath, ['rev-list', '--count', `${ref}..HEAD`])
      ).trim();
      const ahead = Number(aheadStr) || 0;
      if (!best || ahead < best.ahead) {
        best = { ref, ahead };
      } else if (best && ahead === best.ahead) {
        if (ref.startsWith('origin/') && !best.ref.startsWith('origin/')) {
          best = { ref, ahead };
        }
      }
    } catch {
      // skip
    }
  }

  return best?.ref;
}

/**
 * Upstream is only useful as a compare base when it is not just the same
 * feature branch on a remote (origin/my-feature).
 */
async function baseFromUpstream(
  worktreePath: string,
  branch: string,
): Promise<string | undefined> {
  try {
    const upstream = (
      await git(worktreePath, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}',
      ])
    ).trim();
    if (!upstream) {
      return undefined;
    }
    const short = upstream.replace(/^refs\/remotes\//, '');
    const withoutRemote = short.includes('/')
      ? short.slice(short.indexOf('/') + 1)
      : short;
    if (branch && withoutRemote === branch) {
      return undefined;
    }
    return preferRemoteTrackingRef(worktreePath, upstream);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort base ref for comparison (where the worktree/branch started):
 * 1. branch config (vscode-merge-base, etc.)
 * 2. reflog "Created from <ref>" / "checkout: moving from <ref>"
 * 3. upstream, when it is not the feature branch itself
 * 4. closest ancestor among main/staging/develop (+ origin/*)
 * 5. configured default / hard fallbacks
 *
 * Bare names like `staging` are upgraded to `origin/staging` when present
 * so compare uses a current remote tip rather than a stale local branch.
 */
export async function resolveBaseRef(
  worktreePath: string,
  defaultBaseRef: string,
): Promise<string> {
  let branch = '';
  try {
    branch = (
      await git(worktreePath, ['symbolic-ref', '-q', '--short', 'HEAD'])
    ).trim();
  } catch {
    branch = '';
  }

  const fromConfig = await baseFromBranchConfig(worktreePath, branch);
  if (fromConfig) {
    return fromConfig;
  }

  const fromReflog = await baseFromReflog(worktreePath, branch);
  if (fromReflog) {
    return fromReflog;
  }

  const fromUpstream = await baseFromUpstream(worktreePath, branch);
  if (fromUpstream) {
    return fromUpstream;
  }

  const fromAncestor = await baseFromClosestAncestor(worktreePath, defaultBaseRef);
  if (fromAncestor) {
    return fromAncestor;
  }

  const candidates = [
    defaultBaseRef,
    `origin/${defaultBaseRef}`,
    'origin/main',
    'main',
    'origin/master',
    'master',
    'origin/staging',
    'staging',
  ];
  const seen = new Set<string>();
  for (const ref of candidates) {
    if (!ref || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    if (await refResolves(worktreePath, ref)) {
      return preferRemoteTrackingRef(worktreePath, ref);
    }
  }

  return defaultBaseRef;
}
