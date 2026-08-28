/**
 * Which preview is being talked about.
 *
 * Everything below the view layer used to answer that by reading
 * `previewBranch()` — a workspace setting — from 25 call sites. That
 * works only while exactly one preview can exist, and it is the reason
 * a second one is a rewrite rather than a feature: every one of those
 * sites asks "is this THE preview branch?", a boolean, where the
 * question really is "which preview is this, if any?".
 *
 * So the git layer takes an identity instead of consulting a global. Views
 * and commands resolve the current one once and pass it down, which is
 * also what makes the layer testable without a workspace.
 *
 * `stateKey` is the prefix for this preview's files in the git common
 * dir. The DEFAULT preview deliberately has none, keeping the flat
 * `focus-applied` / `focus-candidates` / `focus-base` names — those are a
 * documented protocol shared with agent-focus's `focus-working.sh`, and
 * renaming them would silently break that interop. Additional
 * previews get a prefix; the first one stays where the script expects.
 */
export interface Preview {
  /** The derived preview branch, e.g. `preview/main`. */
  readonly branch: string;
  /** What it is built from, e.g. `origin/main`. */
  readonly baseRef: string;
  /** State-file prefix; absent for the default (flat, script-compatible). */
  readonly stateKey?: string;
}

/** Base name without the remote prefix — `origin/main` → `main`. */
export function baseName(preview: Preview): string {
  return preview.baseRef.replace(/^origin\//, '');
}

/**
 * Name a state file for this preview. The default preview returns
 * the bare name, which is what keeps the shell-script protocol intact.
 */
export function stateFile(preview: Preview, file: string): string {
  return preview.stateKey ? `${preview.stateKey}/${file}` : file;
}
