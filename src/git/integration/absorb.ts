import { git, gitOk } from '../exec';
import { gitErrorMessage, isWorktreeDirty, revParseCommit } from '../plumbing';
import { listWorktreeAdmin } from '../worktreeAdmin';
import { integrationBranch } from './config';
import { mergeOffTree } from './merge';
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

/**
 * Where absorbed work goes. A checkout is preferred when the base has one:
 * the replay is a cherry-pick, so its working tree and index end up
 * consistent with the moved branch. With integration enabled by switching
 * a checkout IN PLACE the base has no worktree at all, and the replay has
 * to happen against the ref itself.
 */
export type AbsorbTarget =
  | { kind: 'checkout'; path: string; branch: string }
  | { kind: 'ref'; branch: string };

/** Human-facing name for a target. */
function absorbTargetLabel(target: AbsorbTarget): string {
  return target.kind === 'checkout' ? target.path : target.branch;
}

export type AbsorbResult =
  | { ok: true; target: string; commits: number; uncommitted: boolean }
  | {
      ok: false;
      code:
        | 'no-target'
        | 'target-dirty'
        | 'nothing'
        | 'conflict'
        | 'busy'
        | 'error'
        | 'needs-confirmation';
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
      if (!state.detached && state.branch === branch) return state.path;
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
      if (source) paths.push(source);
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
  if (incoming.length === 0) return [];
  const dirty = new Set(await dirtyPaths(targetPath));
  return incoming.filter((p) => dirty.has(p));
}

/**
 * Put `paths` back to HEAD in a checkout: unstage, then restore tracked
 * files and delete ones HEAD never had. Scoped on purpose — a hard reset
 * would take the target's unrelated work in progress with it.
 */
async function restorePaths(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
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

/**
 * Paths these commits ADD, relative to each commit's parent.
 *
 * This is the one shape of stray work a replay cannot vet. Every edit to
 * existing content carries the surrounding lines as diff context, so a
 * change written against merged-in lane content fails its 3-way merge
 * against the base and is refused. An added file has no counterpart to
 * check — it applies cleanly whether or not its CONTENTS depend on code
 * that only exists on a lane, and git has no way to tell the difference.
 */
export async function addedPathsInCommits(
  cwd: string,
  shas: string[],
): Promise<string[]> {
  const paths: string[] = [];
  for (const sha of shas) {
    const out = await git(cwd, [
      'show',
      '--pretty=format:',
      '--name-only',
      '--diff-filter=A',
      '-z',
      sha,
    ]).catch(() => '');
    paths.push(...out.split('\0').filter(Boolean));
  }
  return [...new Set(paths)];
}

/**
 * Replay commits onto a branch REF, with no working tree involved.
 *
 * Each commit is re-merged with its own parent as the merge base — that is
 * cherry-pick semantics, so what lands is the stray delta and nothing of
 * the merged lane content it was written on top of. Strict: absorbing user
 * work must never silently drop a hunk to the auto-resolver.
 *
 * The whole run lands as one guarded update-ref, so a branch that moved
 * underneath is a refusal rather than a clobber.
 */
async function replayOntoRef(
  cwd: string,
  branch: string,
  shas: string[],
  from: string,
): Promise<
  { ok: true; tip: string } | { ok: false; message: string; files: string[] }
> {
  const startTip = await revParseCommit(cwd, `refs/heads/${branch}`);
  if (!startTip)
    return { ok: false, message: `${branch} does not resolve`, files: [] };
  let current = startTip;
  for (const sha of shas) {
    const parent = (await git(cwd, ['rev-parse', `${sha}^`]).catch(() => ''))
      .trim();
    if (!parent) {
      return {
        ok: false,
        message: `${sha.slice(0, 10)} has no parent to diff against`,
        files: [],
      };
    }
    const merged = await mergeOffTree(cwd, current, sha, {
      strict: true,
      mergeBase: parent,
    });
    if (merged.kind === 'unsupported') {
      return {
        ok: false,
        message: 'git is too old for an off-tree replay (needs 2.38)',
        files: [],
      };
    }
    if (merged.kind === 'conflict') {
      return {
        ok: false,
        message: `replaying ${sha.slice(0, 10)} onto ${branch} conflicts`,
        files: merged.files,
      };
    }
    const message = `${(
      await git(cwd, ['log', '-1', '--format=%B', sha])
    ).trimEnd()}\n\n${provenance(sha, from)}`;
    const [name = '', email = '', when = ''] = (
      await git(cwd, ['log', '-1', '--format=%an%x00%ae%x00%aI', sha])
    )
      .trim()
      .split('\0');
    current = (
      await git(
        cwd,
        ['commit-tree', merged.tree, '-p', current, '-m', message],
        // Keep authorship with whoever wrote it; the committer becomes
        // whoever ran the absorb, which is what a cherry-pick does too.
        { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: when },
      )
    ).trim();
  }
  try {
    await git(cwd, ['update-ref', `refs/heads/${branch}`, current, startTip]);
  } catch (err) {
    return { ok: false, message: gitErrorMessage(err), files: [] };
  }
  return { ok: true, tip: current };
}

/** Files git reports as unmerged in a checkout. */
/**
 * Provenance for an absorbed commit. The `cherry picked from` line is git's
 * own, so `log`, `range-diff` and friends already understand it; the branch
 * trailer is the half git cannot supply, and the half that matters — the
 * source commit is on a DERIVED branch that the next rebuild destroys, so
 * the sha alone stops resolving almost immediately. Together they answer
 * "where did this come from" after the evidence is gone.
 */
function provenance(sha: string, from: string): string {
  return `(cherry picked from commit ${sha})\nAbsorbed-from: ${from}`;
}

/**
 * git takes `index.lock` for the length of any operation that writes an
 * index, and absorb writes through the TARGET checkout's index — which the
 * extension itself is touching constantly (rebuilds, status probes), as is
 * VS Code's own git extension and whatever the user has open in a terminal.
 * The loser gets a raw `Unable to create ... index.lock` fatal.
 *
 * The lock is held for milliseconds, so the honest response is to wait for
 * it rather than to report a failure the user can do nothing about. Only a
 * lock that outlives every attempt is surfaced — as its own code, because
 * "someone else is mid-operation" is not a conflict and must not read like
 * one.
 */
function isIndexLocked(err: unknown): boolean {
  return /index\.lock/.test(gitErrorMessage(err));
}

const LOCK_WAITS_MS = [50, 100, 200, 400, 800];

async function withIndexLock<T>(run: () => Promise<T>): Promise<T> {
  for (const wait of LOCK_WAITS_MS) {
    try {
      return await run();
    } catch (err) {
      if (!isIndexLocked(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return run();
}

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
  from: string,
): Promise<
  | { ok: true }
  | { ok: false; message: string; files: string[]; locked?: boolean }
> {
  for (const sha of shas) {
    try {
      // -x writes the `cherry picked from` line for us; the branch trailer
      // is amended on after, so both replay paths leave identical
      // provenance. --no-verify on the amend only: the cherry-pick already
      // ran the target's own hooks, and running someone's pre-commit twice
      // for one absorbed commit is its own surprise.
      await withIndexLock(() =>
        git(targetPath, ['cherry-pick', '-x', '--allow-empty', sha]),
      );
      const written = (
        await git(targetPath, ['log', '-1', '--format=%B'])
      ).trimEnd();
      await withIndexLock(() =>
        git(targetPath, [
          'commit',
          '--amend',
          '--no-verify',
          '--allow-empty',
          '-m',
          `${written}\nAbsorbed-from: ${from}`,
        ]),
      );
    } catch (err) {
      const files = await conflictedFiles(targetPath);
      // --quit would keep the commits already replayed; --abort rewinds the
      // whole sequence, which is what "nothing half-absorbed" requires.
      await gitOk(targetPath, ['cherry-pick', '--abort']);
      return {
        ok: false,
        message: isIndexLocked(err)
          ? `${targetPath} is mid-operation (index.lock held) — try again in a moment`
          : gitErrorMessage(err),
        files,
        locked: isIndexLocked(err),
      };
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
  target: AbsorbTarget,
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
  const shas = strays.map((c) => c.sha);
  // Recorded on every absorbed commit. Read from HEAD rather than from
  // config so the trailer names the branch the work was ACTUALLY on, even
  // if the integration branch has since been renamed out from under it.
  const sourceBranch =
    (await git(integrationPath, ['symbolic-ref', '--short', 'HEAD']).catch(
      () => '',
    )).trim() || 'the integration checkout';
  if (target.kind === 'checkout') {
    const incoming = (
      await Promise.all(
        strays.map((c) => pathsInCommit(integrationPath, c.sha)),
      )
    ).flat();
    const clash = await clashingPaths(target.path, incoming);
    if (clash.length > 0) {
      return {
        ok: false,
        code: 'target-dirty',
        message: `the target is already editing ${clash.join(', ')} — commit or stash there first`,
        files: clash,
      };
    }
  }
  // No checkout to clash with in ref mode, and nothing to leave half-done:
  // the replay lands as a single guarded update-ref.
  const replayed =
    target.kind === 'checkout'
      ? await replay(target.path, shas, sourceBranch)
      : await replayOntoRef(integrationPath, target.branch, shas, sourceBranch);
  if (!replayed.ok) {
    return {
      ok: false,
      code: 'locked' in replayed && replayed.locked ? 'busy' : 'conflict',
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
    target: absorbTargetLabel(target),
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
  previewBranch = integrationBranch(),
): Promise<AbsorbResult> {
  if (!(await isWorktreeDirty(integrationPath)))
    return { ok: false, code: 'nothing', message: 'nothing to absorb' };
  let snapshot: string | undefined;
  try {
    snapshot = await snapshotWorktreeCommit(integrationPath, previewBranch);
  } catch (err) {
    return { ok: false, code: 'error', message: gitErrorMessage(err) };
  }
  if (!snapshot)
    return { ok: false, code: 'nothing', message: 'nothing to absorb' };
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
    await withIndexLock(() =>
      git(targetPath, ['cherry-pick', '-n', '--allow-empty', snapshot]),
    );
  } catch (err) {
    if (isIndexLocked(err)) {
      return {
        ok: false,
        code: 'busy',
        message: `${targetPath} is mid-operation (index.lock held) — try again in a moment`,
      };
    }
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
