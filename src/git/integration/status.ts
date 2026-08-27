import { git, gitOk } from '../exec';
import { landedVia } from '../landedProbe';
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
 * Never diverged: the lane tip sits on the base's own FIRST-PARENT line,
 * so the branch carries no commits of its own — a worktree created off the
 * base that has not committed yet (still true after the base moves on and
 * leaves it behind). Structurally distinct from a landed lane, whose tip
 * is the second parent of the merge that brought it in, and from a
 * squash/rebase landing, whose tip is no ancestor at all.
 *
 * Walks first-parent only as far as the lane, so cost tracks the distance
 * between them, not the size of history. Caller must have established that
 * `laneSha` is an ancestor of `baseSha`.
 *
 * A fast-forward landing reads as empty: its tip IS a base first-parent
 * commit, indistinguishable from a fresh branch pointing there — and
 * equally inert, since merging either one changes nothing.
 */
export async function laneNeverDiverged(
  cwd: string,
  laneSha: string,
  baseSha: string,
): Promise<boolean> {
  try {
    const skip =
      Number(
        (
          await git(cwd, [
            'rev-list',
            '--first-parent',
            '--count',
            `${laneSha}..${baseSha}`,
          ])
        ).trim(),
      ) || 0;
    const at = (
      await git(cwd, [
        'rev-list',
        '--first-parent',
        `--skip=${skip}`,
        '--max-count=1',
        baseSha,
      ])
    ).trim();
    return at === laneSha;
  } catch {
    return false;
  }
}

/**
 * Lanes that LANDED: their work is in the base AND they had something to
 * contribute. One predicate for badges and retirement.
 *
 * Delegates to landedVia — the same stack of probes the branch prune uses.
 * This used to run its own weaker check (ancestry, else a strict merge
 * yielding the base tree unchanged), which is correct for a lane that
 * landed while the base sat still and silently wrong afterwards: once the
 * base moves on, that merge CONFLICTS, the lane never reads as landed,
 * never retires, and sits in the preview reporting a conflict forever.
 * Seen in real use — a merged PR's lane stuck as `conflict` — and the fix
 * was already written for prune, just not shared.
 * Revert-safe by construction: after a squash-merge is reverted, merging
 * the lane again WOULD change the tree, so it is not landed.
 *
 * A lane that never diverged is EMPTY, not landed: it is a fresh worktree
 * awaiting its first commit, so it keeps its row and stays applied instead
 * of being tagged done and retired out of the preview.
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
  const landed: string[] = [];
  for (const lane of lanes) {
    const laneSha = await revParseCommit(cwd, `refs/heads/${lane}`);
    if (!laneSha) {
      continue; // branch gone — not our call to make
    }
    const via = await landedVia(cwd, laneSha, baseSha).catch(() => undefined);
    if (!via) {
      continue;
    }
    // A lane that never diverged is EMPTY, not landed — it has nothing to
    // retire, and retiring it would drop a fresh worktree out of the
    // preview before its first commit.
    if (
      via === 'ancestor' &&
      (await laneNeverDiverged(cwd, laneSha, baseSha))
    ) {
      continue;
    }
    landed.push(lane);
  }
  return landed;
}

/**
 * The newest commit on HEAD's first-parent line whose CONTENT is already in
 * `target` — the honest fork point when history says otherwise.
 *
 * Every PR in this repo squash-merges, and that is the case plain `git
 * rebase <target>` gets wrong. A lane stacked on a parent branch carries
 * the parent's original commits; once the parent squash-merges, `target`
 * holds that work as ONE new commit with unrelated shas, so
 * `target..HEAD` still lists the originals and rebase dutifully replays
 * them — against a target that already has the content. Every one of those
 * replays conflicts, and none of the conflicts is real.
 *
 * Detection is by content, not by name, because the parent BRANCH is
 * usually gone by then: GitHub deletes it on merge. So this asks the
 * question that still has an answer — "how much of my history is already
 * in the target, however it got there?" — with the same strict off-tree
 * probe findLandedLanes uses. That makes it uniform across squash, rebase
 * and true merges.
 *
 * Monotone (merging a commit brings its ancestors too), so the boundary is
 * found by binary search: log(n) probes, none of which touch a working
 * tree. Returns undefined when nothing has landed — the ordinary case,
 * where a plain rebase was right all along.
 */
/** Commits to probe before giving up — a lane deeper than this is not the
 *  stacked-on-a-squashed-parent shape this exists for. */
const MAX_FORK_SCAN = 100;

export async function landedPrefix(
  cwd: string,
  headSha: string,
  targetSha: string,
): Promise<string | undefined> {
  let targetTree: string;
  try {
    targetTree = (await git(cwd, ['rev-parse', `${targetSha}^{tree}`])).trim();
  } catch {
    return undefined;
  }
  // Newest first — we want the FURTHEST point that is already in the
  // target, and we want to stop at the first hit.
  const chain = (
    await git(cwd, [
      'rev-list',
      '--first-parent',
      `--max-count=${MAX_FORK_SCAN}`,
      `${targetSha}..${headSha}`,
    ]).catch(() => '')
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Apply the commit's OWN delta to the target: would replaying it change
  // anything? Cherry-pick semantics, the same probe absorb uses.
  const isLanded = async (sha: string): Promise<boolean> => {
    try {
      const parent = (
        await git(cwd, ['rev-parse', '--verify', `${sha}^`])
      ).trim();
      const result = await mergeOffTree(cwd, targetSha, sha, {
        strict: true,
        mergeBase: parent,
      });
      return result.kind === 'tree' && result.tree === targetTree;
    } catch {
      return false; // no parent, or probe failed ⇒ rebase plainly
    }
  };

  for (const [i, sha] of chain.entries()) {
    // The tip itself landing means the whole branch is done — that is
    // retirement's business, not catch-up's; there is nothing to replay.
    if (i === 0) {
      if (await isLanded(sha)) {
        return undefined;
      }
      continue;
    }
    if (await isLanded(sha)) {
      return sha;
    }
  }
  return undefined;
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
  previewBranch = integrationBranch(),
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
    `--exclude=${previewBranch}`,
    '--branches',
    `--exclude=*/${previewBranch}`,
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
