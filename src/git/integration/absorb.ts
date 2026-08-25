import { git, gitOk } from '../exec';
import { gitErrorMessage, isWorktreeDirty } from '../plumbing';
import { listWorktreeAdmin } from '../worktreeAdmin';
import { integrationBranch } from './config';
import { findStrayCommits, resolveBaseSha } from './status';
import { snapshotWorktreeCommit } from './engine';

/**
 * Absorbing stray work out of the integration checkout.
 *
 * The integration tree is DERIVED — base plus merged lanes — so anything
 * written there is destined for a `reset --hard`. The rebuild guards
 * refuse rather than destroy it, which protects the work but deadlocks the
 * preview: nothing ever gets it out. Absorbing is that missing exit.
 *
 * The transplant is exact. A stray commit's diff is taken against its
 * parent, which IS the merged tree, so replaying it elsewhere carries the
 * stray delta and nothing else — lane content stays behind even when the
 * edit sits in a file a lane also touched. Uncommitted strays get the same
 * treatment via an ephemeral snapshot commit.
 *
 * Copy first, clean second: the integration checkout is only reset once
 * the target has the work. A conflict aborts, reports, and leaves both
 * sides exactly as they were.
 */

export type AbsorbResult =
  | { ok: true; target: string; commits: number; uncommitted: boolean }
  | {
      ok: false;
      code: 'no-target' | 'target-dirty' | 'nothing' | 'conflict' | 'error';
      message: string;
      /** Files left conflicted when the replay could not be applied. */
      files?: string[];
    };

/**
 * The checkout that owns `branch`, or undefined when the branch has none.
 * Absorbing needs a real working tree: the replay is a cherry-pick, not a
 * ref update.
 */
export async function checkoutForBranch(
  cwd: string,
  branch: string,
): Promise<string | undefined> {
  try {
    const admin = await listWorktreeAdmin(cwd);
    for (const state of admin.values()) {
      if (!state.detached && state.branch === branch) {
        return state.path;
      }
    }
  } catch {
    // fall through — no admin listing, no target
  }
  return undefined;
}

/**
 * Paths a commit touches, against its first parent — which for both a
 * stray commit and a wip snapshot is the merged integration tree, so this
 * is exactly the set the transplant will write.
 */
async function pathsInCommit(cwd: string, sha: string): Promise<string[]> {
  const out = await git(cwd, [
    'show',
    '--pretty=format:',
    '--name-only',
    '-z',
    sha,
  ]).catch(() => '');
  return out.split('\0').filter(Boolean);
}

/** Paths carrying uncommitted changes in a checkout, untracked included. */
async function dirtyPaths(cwd: string): Promise<string[]> {
  const out = await git(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '-uall',
    '--ignore-submodules=dirty',
  ]).catch(() => '');
  const fields = out.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // A rename/copy spends a second NUL field on its source path, with no
    // status prefix of its own — take it and skip it, or the next loop
    // would read a bare path as a status code.
    if (status.startsWith('R') || status.startsWith('C')) {
      const source = fields[++i];
      if (source) {
        paths.push(source);
      }
    }
  }
  return paths;
}

/**
 * Paths the transplant would write that the target is already editing.
 *
 * Only an OVERLAP blocks absorbing. A blanket "target is clean" rule reads
 * as safer but makes the rescue useless in the normal case — the base
 * checkout usually has work in progress — and git itself only objects to
 * files a replay actually touches.
 */
async function clashingPaths(
  targetPath: string,
  incoming: string[],
): Promise<string[]> {
  if (incoming.length === 0) {
    return [];
  }
  const dirty = new Set(await dirtyPaths(targetPath));
  return incoming.filter((p) => dirty.has(p));
}

/**
 * Put `paths` back to HEAD in a checkout: unstage, then restore tracked
 * files and delete ones HEAD never had. Scoped on purpose — a hard reset
 * would take the target's unrelated work in progress with it.
 */
async function restorePaths(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  await gitOk(cwd, ['reset', '-q', '--', ...paths]);
  for (const file of paths) {
    const tracked = await gitOk(cwd, [
      'cat-file',
      '-e',
      `HEAD:${file}`,
    ]);
    if (tracked) {
      await gitOk(cwd, ['checkout', '-q', 'HEAD', '--', file]);
    } else {
      await gitOk(cwd, ['clean', '-qf', '--', file]);
    }
  }
}

/** Files git reports as unmerged in a checkout. */
async function conflictedFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(
    () => '',
  );
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Replay commits into `targetPath`, aborting the whole run on the first
 * conflict so the target is never left half-absorbed.
 */
async function replay(
  targetPath: string,
  shas: string[],
): Promise<{ ok: true } | { ok: false; message: string; files: string[] }> {
  for (const sha of shas) {
    try {
      await git(targetPath, ['cherry-pick', '--allow-empty', sha]);
    } catch (err) {
      const files = await conflictedFiles(targetPath);
      // --quit would keep the commits already replayed; --abort rewinds the
      // whole sequence, which is what "nothing half-absorbed" requires.
      await gitOk(targetPath, ['cherry-pick', '--abort']);
      return { ok: false, message: gitErrorMessage(err), files };
    }
  }
  return { ok: true };
}

/**
 * Move commits made directly on the integration branch onto the branch
 * checked out at `targetPath`, then rewind the integration checkout to the
 * base so the next rebuild is unblocked.
 *
 * The rewind is safe only because the replay already succeeded — and it is
 * necessary: the replayed copies carry new shas, so without it the
 * originals stay on HEAD's first-parent line and the guard fires forever.
 */
export async function absorbStrayCommits(
  integrationPath: string,
  baseRef: string,
  targetPath: string,
): Promise<AbsorbResult> {
  const baseSha = await resolveBaseSha(integrationPath, baseRef);
  if (!baseSha) {
    return {
      ok: false,
      code: 'error',
      message: `base ref ${baseRef} does not resolve`,
    };
  }
  const strays = await findStrayCommits(integrationPath, baseSha);
  if (strays.length === 0) {
    return {
      ok: false,
      code: 'nothing',
      message: 'no commits to absorb',
    };
  }
  const incoming = (
    await Promise.all(
      strays.map((c) => pathsInCommit(integrationPath, c.sha)),
    )
  ).flat();
  const clash = await clashingPaths(targetPath, incoming);
  if (clash.length > 0) {
    return {
      ok: false,
      code: 'target-dirty',
      message: `the target is already editing ${clash.join(', ')} — commit or stash there first`,
      files: clash,
    };
  }
  const replayed = await replay(
    targetPath,
    strays.map((c) => c.sha),
  );
  if (!replayed.ok) {
    return {
      ok: false,
      code: 'conflict',
      message: replayed.message,
      files: replayed.files,
    };
  }
  try {
    await git(integrationPath, ['reset', '--hard', baseSha]);
  } catch (err) {
    return { ok: false, code: 'error', message: gitErrorMessage(err) };
  }
  return {
    ok: true,
    target: targetPath,
    commits: strays.length,
    uncommitted: false,
  };
}

/**
 * Move UNCOMMITTED edits out of the integration checkout and onto the
 * branch at `targetPath`, where they arrive uncommitted too — the work was
 * never committed, and absorbing must not decide that it is finished.
 *
 * Never call this on a checkout an agent may still be writing to: it
 * restores the integration tree, so a half-written change would be moved
 * out from under whoever is making it.
 */
export async function absorbDirtyEdits(
  integrationPath: string,
  targetPath: string,
): Promise<AbsorbResult> {
  if (!(await isWorktreeDirty(integrationPath))) {
    return { ok: false, code: 'nothing', message: 'nothing to absorb' };
  }
  let snapshot: string | undefined;
  try {
    snapshot = await snapshotWorktreeCommit(integrationPath, integrationBranch());
  } catch (err) {
    return { ok: false, code: 'error', message: gitErrorMessage(err) };
  }
  if (!snapshot) {
    return { ok: false, code: 'nothing', message: 'nothing to absorb' };
  }
  const incoming = await pathsInCommit(integrationPath, snapshot);
  const clash = await clashingPaths(targetPath, incoming);
  if (clash.length > 0) {
    return {
      ok: false,
      code: 'target-dirty',
      message: `the target is already editing ${clash.join(', ')} — commit or stash there first`,
      files: clash,
    };
  }
  try {
    // -n: land the delta in the target's tree and index without committing
    await git(targetPath, ['cherry-pick', '-n', '--allow-empty', snapshot]);
  } catch (err) {
    const files = await conflictedFiles(targetPath);
    // `-n` records NO sequencer state and no CHERRY_PICK_HEAD, so
    // `cherry-pick --abort` refuses ("no cherry-pick in progress") and the
    // markers would survive. Rewind by path instead of by hard reset: the
    // target's own work in progress is none of this operation's business.
    await restorePaths(targetPath, incoming);
    return {
      ok: false,
      code: 'conflict',
      message: gitErrorMessage(err),
      files,
    };
  }
  try {
    // The snapshot holds everything `add -A` saw, so the restore has to
    // cover untracked files too or they would be absorbed AND left behind.
    await git(integrationPath, ['reset', '-q', '--hard', 'HEAD']);
    await git(integrationPath, ['clean', '-qfd']);
  } catch (err) {
    return { ok: false, code: 'error', message: gitErrorMessage(err) };
  }
  return { ok: true, target: targetPath, commits: 0, uncommitted: true };
}
