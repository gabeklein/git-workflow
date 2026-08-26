import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { commonDir } from './lanes';

/**
 * A `git commit` made while the integration branch is checked out is a
 * silent trap: the branch is DERIVED — every rebuild recreates it with
 * `reset --hard` — so the commit has no home. The rebuild's unique guard
 * notices and absorb can rescue the work, but absorb can only ever aim at
 * the BASE branch. When the stray commits actually belonged to a lane,
 * that is the wrong destination, and nothing in the extension can know the
 * difference after the fact.
 *
 * The hook is the one place that can intervene while the intent still
 * exists — at `git commit`, in front of whoever (or whatever) typed it.
 *
 * Hooks are shared across every worktree of a repo (they live in the git
 * COMMON dir), so the script self-checks HEAD and exits 0 instantly
 * anywhere else. The guarded branch name is read from a state file rather
 * than baked into the script, so renaming the integration branch cannot
 * leave a hook guarding a name that no longer exists.
 */

export const GUARD_FILE = 'focus-guard';

/** Line 2 of the script. Marks the hook as ours — and ONLY ours may be overwritten. */
const SENTINEL = '# git-workflow: integration commit guard';

export type GuardState = 'ours' | 'foreign' | 'none';
export type GuardInstall = 'installed' | 'updated' | 'unchanged' | 'foreign';

function hookPath(dir: string): string {
  return path.join(dir, 'hooks', 'pre-commit');
}

const SCRIPT = `#!/bin/sh
${SENTINEL}
#
# Refuses commits made while the derived integration branch is checked out.
# That branch is rebuilt with \`reset --hard\`, so a commit on it has no home.
#
# This file is managed by the Git Workflow extension. Delete it, or turn off
# worktreeCompare.integrationCommitGuard, to stop guarding.

dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
[ -f "$dir/${GUARD_FILE}" ] || exit 0
guarded=$(cat "$dir/${GUARD_FILE}" 2>/dev/null) || exit 0
[ -n "$guarded" ] || exit 0

head=$(git symbolic-ref --short HEAD 2>/dev/null) || exit 0
[ "$head" = "$guarded" ] || exit 0

exec >&2
echo
echo "  Refusing to commit on $guarded."
echo
echo "  That branch is a PREVIEW built by Git Workflow — the base branch with"
echo "  the applied lanes merged on top. Every rebuild recreates it, so a"
echo "  commit made here does not survive and does not belong to any lane."
echo
echo "  Your changes are untouched and still staged. Pick an exit:"
echo
echo "    * Check out the branch this work belongs to and commit there."
echo "    * Run Git Workflow: Absorb Integration Edits to move the working"
echo "      tree onto the base branch, then commit there."
echo "    * git commit --no-verify   (you meant it; absorb can rescue it later)"
echo
exit 1
`;

async function read(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function classify(existing: string | undefined): GuardState {
  if (existing === undefined) {
    return 'none';
  }
  return existing.includes(SENTINEL) ? 'ours' : 'foreign';
}

/** Whether a pre-commit hook exists, and whether it is one we may replace. */
export async function commitGuardState(cwd: string): Promise<GuardState> {
  const dir = await commonDir(cwd);
  return classify(await read(hookPath(dir)));
}

/**
 * Install (or refresh) the hook and point it at `branch`. A pre-commit hook
 * we did not write is never touched — losing someone's lint-staged setup to
 * a safety feature would be its own footgun.
 */
export async function installCommitGuard(
  cwd: string,
  branch: string,
): Promise<GuardInstall> {
  const dir = await commonDir(cwd);
  const hook = hookPath(dir);
  const existing = await read(hook);
  const state = classify(existing);
  if (state === 'foreign') {
    return 'foreign';
  }
  const marker = path.join(dir, GUARD_FILE);
  // 'unchanged' has to mean BOTH halves already agree: the script rarely
  // changes, but the branch it points at does (rename, base change), and a
  // caller logging only real changes needs that to show up.
  const settled = existing === SCRIPT && (await read(marker))?.trim() === branch;
  if (settled) {
    return 'unchanged';
  }
  await fs.mkdir(path.dirname(hook), { recursive: true });
  await fs.writeFile(marker, `${branch}\n`);
  if (existing !== SCRIPT) {
    await fs.writeFile(hook, SCRIPT, { mode: 0o755 });
    // writeFile does not chmod a file that already existed
    await fs.chmod(hook, 0o755);
  }
  return state === 'ours' ? 'updated' : 'installed';
}

/**
 * Stop guarding. The state file goes first so the hook is inert the instant
 * this starts, even if removing the script fails; a hook we did not write
 * stays where it is.
 */
export async function uninstallCommitGuard(cwd: string): Promise<void> {
  const dir = await commonDir(cwd);
  await fs.rm(path.join(dir, GUARD_FILE), { force: true });
  const hook = hookPath(dir);
  if (classify(await read(hook)) === 'ours') {
    await fs.rm(hook, { force: true });
  }
}

/** The branch the installed hook is currently refusing commits on, if any. */
export async function guardedBranch(cwd: string): Promise<string | undefined> {
  const dir = await commonDir(cwd);
  const raw = await read(path.join(dir, GUARD_FILE));
  return raw?.trim() || undefined;
}
