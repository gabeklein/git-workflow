import { type RebuildResult, rebuildPreview } from './engine';
import { type PreviewSettings, readPreviewSettings } from './settings';

/**
 * "Rebuild this repo's preview" as one operation, so the daemon and the
 * editor cannot mean different things by it.
 *
 * The engine was never duplicated — both call rebuildPreview — but its
 * INPUTS were assembled twice: the daemon from focus-config, the editor
 * from live workspace settings. Two assemblies of the same argument list
 * is where a divergence would eventually appear, and it would appear as
 * the worst possible symptom: a preview that depends on who built it. So
 * the operation lives here, once, and the two callers differ only in where
 * their settings come from.
 *
 * The editor passes its settings in (they are live, and authoritative);
 * anything else reads what the editor recorded.
 */

export type RebuildOutcome =
  | { kind: 'ran'; result: RebuildResult }
  | { kind: 'unconfigured'; message: string };

export async function rebuildFromSettings(
  cwd: string,
  settings?: PreviewSettings,
): Promise<RebuildOutcome> {
  const resolved = settings ?? (await readPreviewSettings(cwd));
  if (!resolved) {
    // Preview off, or an editor that has not recorded its settings yet.
    // Rebuilding against a guessed branch would reset the wrong checkout,
    // so this refuses in a way callers report rather than treat as a
    // failed preview.
    return {
      kind: 'unconfigured',
      message:
        'no preview settings recorded (focus-config) — preview may be off',
    };
  }
  return {
    kind: 'ran',
    result: await rebuildPreview(resolved.checkout, resolved.base, {
      branch: resolved.branch,
      baseRef: resolved.base,
    }),
  };
}
