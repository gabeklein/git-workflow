import { git, gitOk } from '../exec';
import { revParseCommit } from '../plumbing';
import { integrationBaseRef, integrationBranch, WIP_SUBJECT } from './config';
import { mergeOffTree } from './merge';
import { listAppliedLanes, listExcludedLanes, readBasePin } from './lanes';

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
  // The drift lane (unpushed commits on the local base) is part of the
  // preview: the pinned base line above deliberately does not move when
  // the local base does, so track it separately — a commit on main must
  // trigger a rebuild even though the base itself holds.
  const baseName = baseRef.replace(/^origin\//, '');
  const excluded = await listExcludedLanes(cwd).catch((): string[] => []);
  parts.push(
    `drift\0${
      excluded.includes(baseName)
        ? 'excluded'
        : ((await revParseCommit(cwd, `refs/heads/${baseName}`)) ?? 'none')
    }`,
  );
  // Work committed directly on the integration checkout blocks the rebuild
  // but moves none of the refs above, so without this the tick would never
  // notice it and the absorb rescue would wait for an unrelated trigger.
  // A count is enough to fire on, and it is STABLE: after a rebuild the
  // first-parent line from the base up to HEAD is all merge commits, so
  // this reads 0 and does not re-arm itself. The authoritative scan
  // (findStrayCommits) carries the belt for a force-pushed base.
  const strays = (
    await git(cwd, [
      'rev-list',
      '--count',
      '--no-merges',
      '--first-parent',
      'HEAD',
      '--not',
      parts[0].split('\0')[1] ?? 'HEAD',
    ]).catch(() => '0')
  ).trim();
  parts.push(`strays\0${strays}`);
  for (const lane of lanes) {
    const sha =
      (await revParseCommit(cwd, `refs/heads/${lane}`)) ?? 'missing';
    parts.push(`${lane}\0${sha}`);
  }
  return parts.join('\n');
}

/**
 * Commits made DIRECTLY on the integration checkout — work that exists on
 * no other branch and would be destroyed by the next `reset --hard`.
 *
 * They sit on HEAD's first-parent line as non-merges; lane content always
 * arrives via merge second parents, so this is immune to lanes being
 * rebased afterwards (their old commits leave every branch but stay buried
 * in the chain). Ephemeral wip snapshots are excluded — the extension made
 * those, nobody committed them.
 *
 * Oldest first, so callers can replay them in order.
 */
export async function findStrayCommits(
  cwd: string,
  baseSha: string,
): Promise<{ sha: string; subject: string }[]> {
  const out = await git(cwd, [
    'log',
    '--no-merges',
    '--first-parent',
    '--reverse',
    '--format=%H%x00%s',
    'HEAD',
    '--not',
    baseSha,
    // Belt for a diverged/force-pushed base: anything still on a branch or
    // remote is not lost. (--exclude expires per glob.)
    `--exclude=${integrationBranch()}`,
    '--branches',
    `--exclude=*/${integrationBranch()}`,
    '--remotes',
  ]).catch(() => '');
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha, subject = ''] = l.split('\0');
      return { sha, subject };
    })
    .filter((c) => !c.subject.startsWith(WIP_SUBJECT));
}
