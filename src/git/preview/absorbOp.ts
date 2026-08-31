import {
  type AbsorbResult,
  absorbDirtyEdits,
  absorbStrayCommits,
  addedPathsInCommits,
  resolveAbsorbTarget,
} from './absorb';
import { isWorktreeDirty } from '../plumbing';
import { listAppliedLanes, withRepoLock } from './lanes';
import { type PreviewSettings, readPreviewSettings } from './settings';
import { findStrayCommits, resolveBaseSha } from './status';

/**
 * "Absorb this preview checkout onto the base", runnable from a shell.
 *
 * The sibling of rebuildOp: the controller's absorb is wired to dialogs
 * and a tree, and neither exists in a terminal. This is the same two
 * primitives (stray commits, then uncommitted edits) with the decision a
 * dialog used to make spelled as a flag and an exit code instead.
 *
 * It exists because absorb is the only move aimed at the BASE, which makes
 * it the wrong rescue for lane work and the RIGHT one for a fix that
 * belongs to the base itself — a hotfix found while reading the preview,
 * where the merged lanes are what made it visible. Until now that ran
 * through the sidebar alone, so an agent stopped by the commit guard had
 * nowhere to go but `--no-verify`.
 */

export type AbsorbOutcome =
  | { kind: 'ran'; result: AbsorbResult }
  | { kind: 'unconfigured'; message: string }
  | { kind: 'busy'; message: string };

export interface AbsorbOptions {
  /**
   * Allow stray commits that ADD files while lanes are applied. An added
   * file carries no diff context, so it applies to the base cleanly even
   * when its contents depend on a lane's code — the one shape the replay
   * cannot vet. In the editor this is a dialog; a terminal has to be told
   * up front.
   */
  allowAdded?: boolean;
  settings?: PreviewSettings;
  /** Mostly for tests: how long to queue behind another writer. */
  waitMs?: number;
}

export async function absorbFromSettings(
  cwd: string,
  options: AbsorbOptions = {},
): Promise<AbsorbOutcome> {
  const resolved = options.settings ?? (await readPreviewSettings(cwd));
  if (!resolved) {
    // Same refusal as a rebuild's, and for the same reason: absorbing
    // against a guessed base would rewrite the wrong branch.
    return {
      kind: 'unconfigured',
      message:
        'no preview settings recorded (focus-config) — preview may be off',
    };
  }
  const { checkout, base, branch } = resolved;
  const target = await resolveAbsorbTarget(checkout, base);
  if (!target) {
    return {
      kind: 'ran',
      result: {
        ok: false,
        code: 'no-target',
        message: `${base.replace(/^origin\//, '')} does not exist locally — nothing to absorb into`,
      },
    };
  }

  // Held for the whole operation, because it both rewrites the base and
  // `reset --hard`s the preview checkout: a rebuild racing this would
  // recreate the tree from under a half-finished transplant. Queued for
  // rather than failed on — the holder is usually a rebuild, and an
  // absorb is just as valid once it finishes.
  const ran = await withRepoLock(
    cwd,
    'absorb',
    async (): Promise<AbsorbResult> => {
      const baseSha = await resolveBaseSha(checkout, base);
      const strays = baseSha
        ? await findStrayCommits(checkout, baseSha, branch)
        : [];

      // Commits first: they are the explicit act, and unlike edits they
      // can land on a ref, which is the only target the shipped layout
      // has.
      if (strays.length > 0) {
        if (!options.allowAdded && (await listAppliedLanes(cwd)).length > 0) {
          const added = await addedPathsInCommits(
            checkout,
            strays.map((c) => c.sha),
          );
          if (added.length > 0) {
            return {
              ok: false,
              code: 'needs-confirmation',
              message:
                `these commits add ${added.join(', ')} while lanes are merged in — ` +
                'an added file has no diff context, so it lands on the base even ' +
                'if its contents depend on lane code. Re-run with --allow-added ' +
                'if that is what you mean.',
              files: added,
            };
          }
        }
        return absorbStrayCommits(checkout, base, target, branch);
      }

      if (!(await isWorktreeDirty(checkout)))
        return { ok: false, code: 'nothing', message: 'nothing to absorb' };

      // Uncommitted work has to land in a working tree — a ref has none,
      // and committing it on the author's behalf would be deciding it is
      // finished. With preview enabled in place the base has no checkout,
      // so this is the common answer rather than the rare one, and the
      // way through is to commit first.
      if (target.kind !== 'checkout') {
        return {
          ok: false,
          code: 'no-target',
          message:
            `${target.branch} has no worktree, so uncommitted edits have nowhere ` +
            'to land. Commit them here (the guard will refuse — that refusal ' +
            'names this exit) and absorb again, or check the base out somewhere.',
        };
      }
      return absorbDirtyEdits(checkout, target.path, branch);
    },
    { waitMs: options.waitMs },
  );

  if (!ran)
    return {
      kind: 'busy',
      message: 'the preview is busy — another writer holds the lock',
    };
  return { kind: 'ran', result: ran };
}
