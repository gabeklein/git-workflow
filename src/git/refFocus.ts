import {
  ensurePrHeadFetched,
  prRemoteRef,
  resolvePrBaseRef,
} from '../github/remotePrs';
import { git, gitOk } from './exec';

/**
 * A branch focused WITHOUT a checkout — what the Focus panel shows when
 * you click a Local, Remote or Landed row instead of a Working one.
 *
 * A worktree is the usual subject of the panel, but the question it
 * answers — what does this branch change, and in which commits — needs
 * only the ref. So a branch with no folder is explored read-only, from the
 * repo's shared refs, rather than first having to be checked out.
 */
export interface RefFocus {
  /** What git resolves: `feat-x`, `origin/feat-x` or `refs/remotes/pr/12`. */
  ref: string;
  /** The branch name the row showed. */
  branch: string;
  /**
   * Where the ref lives. `pr` is a PR head with no branch ref of its own
   * (a fork), reachable only as `pull/<n>/head`.
   */
  source: 'local' | 'remote' | 'pr';
  /** Its open PR, whose base is what the branch is measured against. */
  pr?: { number: number; baseRefName?: string };
  /**
   * A base fixed by whoever focused it — a stacked branch's parent, a
   * commit's own parent, a combination's merge-base. Outranks the PR's.
   */
  base?: string;
  /** Panel description, when the branch name is not what this is. */
  label?: string;
  /** Paths that clashed building it (a combined focus). */
  conflicts?: string[];
  /**
   * Browse the ref's own history instead of diffing it — the trunk, which
   * has no base to be measured against.
   */
  history?: boolean;
  /**
   * The refs a combined focus was merged from. Its own ref is a commit
   * built once, so these are what say it went stale.
   */
  parts?: string[];
}

/** What a branch row knows about itself — enough to pick the ref. */
export interface BranchRowInfo {
  branch: string;
  hasLocalRef?: boolean;
  hasRemote?: boolean;
  pr?: { number: number; baseRefName?: string };
}

/**
 * The ref to focus for a branch row. The local ref wins when there is
 * one — it is the version you have — then origin's, then the PR head.
 */
export function refFocusForBranch(row: BranchRowInfo): RefFocus {
  const pr = row.pr
    ? { number: row.pr.number, baseRefName: row.pr.baseRefName }
    : undefined;
  if (row.hasLocalRef)
    return { ref: row.branch, branch: row.branch, source: 'local', pr };
  if (!row.hasRemote && pr)
    return { ref: prRemoteRef(pr.number), branch: row.branch, source: 'pr', pr };
  return {
    ref: `origin/${row.branch}`,
    branch: row.branch,
    source: 'remote',
    pr,
  };
}

/**
 * Read a focus back from workspace state. Anything malformed is no focus
 * at all — a stale or hand-edited value must fall back to a checkout, not
 * throw while the panel renders.
 */
export function parseStoredRefFocus(value: unknown): RefFocus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.ref !== 'string' || !v.ref) return undefined;
  if (typeof v.branch !== 'string' || !v.branch) return undefined;
  if (v.source !== 'local' && v.source !== 'remote' && v.source !== 'pr')
    return undefined;
  let pr: RefFocus['pr'];
  if (v.pr && typeof v.pr === 'object') {
    const p = v.pr as Record<string, unknown>;
    if (typeof p.number === 'number') {
      pr = {
        number: p.number,
        baseRefName:
          typeof p.baseRefName === 'string' ? p.baseRefName : undefined,
      };
    }
  }
  const str = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
  const conflicts = Array.isArray(v.conflicts)
    ? v.conflicts.filter((c): c is string => typeof c === 'string')
    : undefined;
  const parts = Array.isArray(v.parts)
    ? v.parts.filter((c): c is string => typeof c === 'string' && c.length > 0)
    : undefined;
  return {
    ref: v.ref,
    branch: v.branch,
    source: v.source,
    pr,
    base: str(v.base),
    label: str(v.label),
    conflicts: conflicts?.length ? conflicts : undefined,
    history: v.history === true ? true : undefined,
    parts: parts && parts.length >= 2 ? parts : undefined,
  };
}

/** Panel description: the branch, and that it is not a checkout. */
export function describeRefFocus(focus: RefFocus): string {
  if (focus.label) return focus.label;
  switch (focus.source) {
    case 'local':
      return `${focus.branch} (no worktree)`;
    case 'pr':
      return `${focus.branch} (PR #${focus.pr?.number ?? '?'})`;
    default:
      return `${focus.branch} (remote)`;
  }
}

export function refExists(repoCwd: string, ref: string): Promise<boolean> {
  return gitOk(repoCwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/**
 * Make the focused ref resolvable, fetching it when it is not.
 *
 * Only what is missing is fetched: a remote-tracking ref that exists is
 * explored as it is, the same staleness every other remote row has. A
 * local branch is never fetched — if it is gone, it is gone. No local
 * branch is created either; that is what Create Worktree is for.
 *
 * Returns whether a fetch ran, so the caller can refresh the branch list.
 */
export async function ensureRefFocusFetched(
  repoCwd: string,
  focus: RefFocus,
): Promise<boolean> {
  if (await refExists(repoCwd, focus.ref)) return false;
  switch (focus.source) {
    case 'local':
      throw new Error(`branch ${focus.branch} no longer exists`);
    case 'pr':
      if (!focus.pr) throw new Error(`no PR to fetch for ${focus.branch}`);
      await ensurePrHeadFetched(repoCwd, focus.pr.number);
      return true;
    default:
      // Explicit refspec: a bare `fetch origin <b>` only updates
      // FETCH_HEAD on configurations without the default refspec.
      await git(repoCwd, [
        'fetch',
        'origin',
        `+refs/heads/${focus.branch}:refs/remotes/origin/${focus.branch}`,
      ]);
      return true;
  }
}

/**
 * What a focused ref is measured against: its PR's base when it has one —
 * that is the diff its reviewers see — otherwise `fallback`, the same base
 * a fresh checkout would be compared with.
 */
export async function refFocusBase(
  repoCwd: string,
  focus: RefFocus,
  fallback: string,
): Promise<string> {
  if (focus.base) return focus.base;
  if (focus.pr?.baseRefName)
    return resolvePrBaseRef(repoCwd, focus.pr.baseRefName);
  return fallback;
}

/** `<ref sha> <base sha>` — cheap "has anything moved?" for a focused ref. */
export async function refFocusTips(
  repoCwd: string,
  ref: string,
  baseRef: string,
): Promise<string> {
  return (await git(repoCwd, ['rev-parse', ref, baseRef]))
    .trim()
    .split('\n')
    .join(' ');
}
