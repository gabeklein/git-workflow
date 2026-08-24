import { git, gitOk } from '../exec';
import { revParseCommit } from '../plumbing';
import { integrationBaseRef } from './config';
import { mergeOffTree } from './merge';
import { listAppliedLanes, readBasePin } from './lanes';

export async function resolveBaseSha(
  cwd: string,
  baseRef: string,
): Promise<string | undefined> {
  const name = baseRef.replace(/^origin\//, '');
  const sha = (ref: string) => revParseCommit(cwd, ref);
  const remote = await sha(`origin/${name}`);

  // Base pin (integration base only): the base FOLLOWS origin when that
  // is a descendant of the pin — published movement is always legit —
  // and otherwise holds the pin, so commits made directly on the local
  // base branch never silently retarget the preview. Drift is surfaced
  // on the Integration panel with Convert-to-Branch / Catch Up exits.
  if (name === integrationBaseRef().replace(/^origin\//, '')) {
    const pin = await readBasePin(cwd);
    if (pin && (await sha(pin))) {
      if (
        remote &&
        remote !== pin &&
        (await gitOk(cwd, ['merge-base', '--is-ancestor', pin, remote]))
      ) {
        return remote;
      }
      return pin;
    }
  }

  // No pin: prefer the DESCENDANT when both exist — the remote tip when
  // PRs land on the host, the local tip in local-only workflows where the
  // user advances the base directly. Diverged → origin (a fetch reconciles).
  const local = await sha(`refs/heads/${name}`);
  if (remote && local && remote !== local) {
    if (await gitOk(cwd, ['merge-base', '--is-ancestor', remote, local])) {
      return local;
    }
    return remote;
  }
  return remote ?? local ?? sha(baseRef);
}

/** Best-effort `git fetch origin <base>` so origin/<base> tracks reality. */
export async function fetchIntegrationBase(
  cwd: string,
  baseRef: string,
): Promise<boolean> {
  const name = baseRef.replace(/^origin\//, '');
  return gitOk(cwd, ['fetch', 'origin', name]);
}

/**
 * Lanes that LANDED: merging them into the base changes nothing. One
 * predicate for badges and retirement, deliberately content-based:
 * - ancestry (true-merge landings) — merging an ancestor is a no-op;
 * - content-neutral (squash/rebase landings) — a STRICT off-tree merge
 *   yields the base tree unchanged.
 * Revert-safe by construction: after a squash-merge is reverted, merging
 * the lane again WOULD change the tree, so it is not landed.
 */
export async function findLandedLanes(
  cwd: string,
  baseRef: string,
  lanes: string[],
): Promise<string[]> {
  const baseSha = await resolveBaseSha(cwd, baseRef);
  if (!baseSha) {
    return [];
  }
  let baseTree: string;
  try {
    baseTree = (await git(cwd, ['rev-parse', `${baseSha}^{tree}`])).trim();
  } catch {
    return [];
  }
  const landed: string[] = [];
  for (const lane of lanes) {
    const laneSha = await revParseCommit(cwd, `refs/heads/${lane}`);
    if (!laneSha) {
      continue; // branch gone — not our call to make
    }
    if (await gitOk(cwd, ['merge-base', '--is-ancestor', laneSha, baseSha])) {
      landed.push(lane);
      continue;
    }
    try {
      const result = await mergeOffTree(cwd, baseSha, laneSha, {
        strict: true,
      });
      if (result.kind === 'tree' && result.tree === baseTree) {
        landed.push(lane);
      }
    } catch {
      // probe failure ⇒ not landed
    }
  }
  return landed;
}

/**
 * Merge two commits without touching any working tree.
 * Returns the merged tree oid, a conflict (with the files), or
 * 'unsupported' when git predates merge-tree --write-tree (< 2.38).
 */

export interface BaseStatus {
  /** Commits the base has that this branch lacks */
  behind: number;
  /** Commits this branch has that the base lacks */
  ahead: number;
  /** Merging/rebasing onto the base would conflict (strict off-tree probe) */
  conflicts: boolean;
  refSha: string;
  baseSha: string;
}

/**
 * How a branch relates to the base — no working-tree access. The conflict
 * probe is STRICT (independent of integrationAutoResolve): the badge must
 * reflect what a real `git rebase`/`git merge` would hit.
 */
export async function baseStatusFor(
  cwd: string,
  ref: string,
  baseRef: string,
  /** Probe results keyed `${refSha}:${baseSha}` — pass a persistent map
   *  so merge-tree probes rerun only when a tip actually moves. */
  probeMemo?: Map<string, boolean>,
): Promise<BaseStatus | undefined> {
  const baseSha = await resolveBaseSha(cwd, baseRef);
  if (!baseSha) {
    return undefined;
  }
  const refSha = await revParseCommit(cwd, ref);
  if (!refSha) {
    return undefined;
  }
  const counts = (
    await git(cwd, [
      'rev-list',
      '--left-right',
      '--count',
      `${refSha}...${baseSha}`,
    ])
  )
    .trim()
    .split(/\s+/);
  const ahead = Number(counts[0]) || 0;
  const behind = Number(counts[1]) || 0;
  let conflicts = false;
  if (behind > 0 && ahead > 0) {
    const memoKey = `${refSha}:${baseSha}`;
    const memoized = probeMemo?.get(memoKey);
    if (memoized !== undefined) {
      conflicts = memoized;
    } else {
      const probe = await mergeOffTree(cwd, refSha, baseSha, {
        strict: true,
      }).catch(() => ({ kind: 'tree' }) as const);
      conflicts = probe.kind === 'conflict';
      probeMemo?.set(memoKey, conflicts);
      if (probeMemo && probeMemo.size > 512) {
        probeMemo.clear();
      }
    }
  }
  return { behind, ahead, conflicts, refSha, baseSha };
}

export async function integrationFingerprint(
  cwd: string,
  baseRef: string,
): Promise<string> {
  const lanes = await listAppliedLanes(cwd);
  const parts: string[] = [`base\0${await resolveBaseSha(cwd, baseRef)}`];
  for (const lane of lanes) {
    const sha =
      (await revParseCommit(cwd, `refs/heads/${lane}`)) ?? 'missing';
    parts.push(`${lane}\0${sha}`);
  }
  return parts.join('\n');
}
