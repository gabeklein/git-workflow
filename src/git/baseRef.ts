import { git, gitOk } from './exec';

/** Well-known preview-branch names used when inferring a compare base. */
const PREVIEW_NAMES = [
  'main',
  'master',
  'staging',
  'develop',
  'development',
  'trunk',
  'release',
];

async function refResolves(worktreePath: string, ref: string): Promise<boolean> {
  if (!ref) return false;
  return gitOk(worktreePath, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

const REMOTES = ['origin', 'upstream'];

/**
 * Prefer the remote-tracking counterpart when the local name may be stale.
 * `staging` → `origin/staging`, and `release/2.0` → `origin/release/2.0`,
 * when that ref exists. A slash does not make a name remote: only a name
 * that IS a remote-tracking ref (`origin/x`, `refs/...`) is left alone.
 */
export async function preferRemoteTrackingRef(
  worktreePath: string,
  ref: string,
): Promise<string> {
  const trimmed = ref.trim();
  if (!trimmed || trimmed === 'HEAD' || trimmed.includes('..')) return trimmed;
  if (trimmed.startsWith('refs/')) return trimmed;
  if (trimmed.includes('/')) {
    if (REMOTES.includes(trimmed.slice(0, trimmed.indexOf('/'))))
      return trimmed;
    if (await refResolves(worktreePath, `refs/remotes/${trimmed}`))
      return trimmed;
  }
  for (const remote of REMOTES) {
    const candidate = `${remote}/${trimmed}`;
    if (await refResolves(worktreePath, candidate)) return candidate;
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
  if (!branch || branch === 'HEAD' || branch === 'unknown') return undefined;

  const trySource = async (
    sourceRaw: string,
    line: string,
  ): Promise<string | undefined> => {
    let source = sourceRaw.trim().replace(/[.,;]+$/, '');
    if (!source) return undefined;
    if (source === 'HEAD') {
      const hashMatch = line.match(/^([0-9a-f]{7,40})\s/i);
      if (hashMatch?.[1])
        return namePreviewRefAt(worktreePath, hashMatch[1]);
      return undefined;
    }
    if (source === branch || source.endsWith(`/${branch}`)) return undefined;
    // A PR head fetched for review (refs/remotes/pr/<n>, refs/pull/<n>/head)
    // is the branch's own tip, not where it forks — 0 ahead, empty diff.
    if (isPullHeadRef(source)) return undefined;
    if (await refResolves(worktreePath, source))
      return preferRemoteTrackingRef(worktreePath, source);
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
        if (hit) return hit;
      }
      const checkout = line.match(
        /checkout:\s+moving from\s+(.+?)\s+to\s+(\S+)\s*$/i,
      );
      if (checkout?.[1] && checkout[2]) {
        const to = checkout[2].trim();
        if (to === branch || to === 'HEAD') {
          const hit = await trySource(checkout[1], line);
          if (hit) return hit;
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
    if (fromBranch) return fromBranch;
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

function isPullHeadRef(ref: string): boolean {
  return /^(refs\/remotes\/pr\/|refs\/pull\/|pr\/\d+$)/.test(ref);
}

/** If commit is exactly an preview branch tip, return that ref name. */
async function namePreviewRefAt(
  worktreePath: string,
  commit: string,
): Promise<string | undefined> {
  for (const ref of previewCandidates()) {
    if (!(await refResolves(worktreePath, ref))) continue;
    try {
      const tip = (await git(worktreePath, ['rev-parse', ref])).trim();
      const target = (await git(worktreePath, ['rev-parse', commit])).trim();
      if (tip === target) return ref;
    } catch {
      // skip
    }
  }
  return undefined;
}

function previewCandidates(extra?: string): string[] {
  const names = [...PREVIEW_NAMES];
  if (extra && !names.includes(extra)) names.unshift(extra);
  const refs: string[] = [];
  for (const n of names) {
    // Prefer remote tips first — local preview branches are often stale
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
  if (!branch || branch === 'HEAD' || branch === 'unknown') return undefined;
  const keys = [
    `branch.${branch}.vscode-merge-base`,
    `branch.${branch}.merge-base`,
    `branch.${branch}.gh-merge-base`,
  ];
  for (const key of keys) {
    try {
      const value = (await git(worktreePath, ['config', '--get', key])).trim();
      if (value && (await refResolves(worktreePath, value)))
        return preferRemoteTrackingRef(worktreePath, value);
    } catch {
      // unset
    }
  }
  return undefined;
}

/**
 * The base an OPEN pull request targets is where the branch will land, so it
 * outranks every guess about where it started — a stale vscode-merge-base,
 * a reflog naming the PR head, an upstream that is the branch itself.
 * Resolved to the remote-tracking ref when present; undefined (fall through
 * to inference) when no such ref exists here yet.
 */
export async function baseFromPullRequest(
  worktreePath: string,
  prBaseRefName: string | undefined,
): Promise<string | undefined> {
  const name = prBaseRefName?.trim();
  if (!name) return undefined;
  const preferred = await preferRemoteTrackingRef(worktreePath, name);
  return (await refResolves(worktreePath, preferred)) ? preferred : undefined;
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
    if (!upstream) return undefined;
    const short = upstream.replace(/^refs\/remotes\//, '');
    const withoutRemote = short.includes('/')
      ? short.slice(short.indexOf('/') + 1)
      : short;
    if (branch && withoutRemote === branch) return undefined;
    return preferRemoteTrackingRef(worktreePath, upstream);
  } catch {
    return undefined;
  }
}

/**
 * GENUINE inference only — evidence about where THIS branch belongs: the
 * open PR's base (when the caller knows one), then branch config (vscode-merge-base, etc.), reflog "Created from <ref>" /
 * "checkout: moving from <ref>", or upstream (when it is not the feature
 * branch itself). undefined = no evidence; callers that GUESS (candidate
 * scan, configured default) must not treat their fallback as inference —
 * auto-membership in particular never enrolls on a guess.
 */
export async function inferBaseRef(
  worktreePath: string,
  prBaseRefName?: string,
): Promise<string | undefined> {
  const fromPr = await baseFromPullRequest(worktreePath, prBaseRefName);
  if (fromPr) return fromPr;
  let branch = '';
  try {
    branch = (
      await git(worktreePath, ['symbolic-ref', '-q', '--short', 'HEAD'])
    ).trim();
  } catch {
    branch = '';
  }

  return (
    (await baseFromBranchConfig(worktreePath, branch)) ??
    (await baseFromReflog(worktreePath, branch)) ??
    (await baseFromUpstream(worktreePath, branch))
  );
}

/**
 * Best-effort base ref for comparison (where the worktree/branch started):
 * 1. genuine inference (open PR base / branch config / reflog / upstream —
 *    inferBaseRef)
 * 2. closest ancestor among main/staging/develop (+ origin/*)
 * 3. configured default / hard fallbacks
 *
 * Bare names like `staging` are upgraded to `origin/staging` when present
 * so compare uses a current remote tip rather than a stale local branch.
 */
export async function resolveBaseRef(
  worktreePath: string,
  defaultBaseRef: string,
  prBaseRefName?: string,
): Promise<string> {
  const inferred = await inferBaseRef(worktreePath, prBaseRefName);
  if (inferred) return inferred;

  // Skip closest-ancestor scan by default — it can spawn dozens of git
  // processes on large repos and was a hang risk. Prefer quick fallbacks.
  const candidates = [
    `origin/${defaultBaseRef}`,
    defaultBaseRef,
    'origin/staging',
    'staging',
    'origin/main',
    'main',
    'origin/master',
    'master',
  ];
  const seen = new Set<string>();
  for (const ref of candidates) {
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    if (await refResolves(worktreePath, ref))
      return preferRemoteTrackingRef(worktreePath, ref);
  }

  return defaultBaseRef;
}
