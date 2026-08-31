import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { commonDir } from './lanes';

/**
 * The preview's settings, resolved and written down.
 *
 * Everything the rebuild needs is a workspace setting today, which means
 * the engine can only run where `vscode` can be imported — the one thing
 * standing between this feature and a headless implementation. The values
 * are not secret and they change rarely, so the fix is to persist them
 * beside the rest of the lane state when preview is enabled, exactly as
 * `gw-lane` and the commit guard are.
 *
 * The editor remains the only WRITER: it owns the settings UI, so nothing
 * else has an opinion to record. Readers are the one-shot CLI (and its
 * vscode shim, which serves these values to the unmodified engine) and
 * anyone diagnosing by eye.
 */

export const CONFIG_FILE = 'focus-config';

export interface PreviewSettings {
  /** Resolved branch name — `{base}` already substituted. */
  branch: string;
  /** What it builds from, e.g. `origin/main`. */
  base: string;
  /** The checkout holding the preview: the workspace root. */
  checkout: string;
  /** Raw `previewAutoResolve` setting; the resolver maps it. */
  autoResolve?: string;
}

function encode(s: PreviewSettings): string {
  return [
    '# git-workflow: the preview settings, resolved by the editor.',
    '# Generated — the editor rewrites this whenever preview is enabled.',
    `branch: ${s.branch}`,
    `base: ${s.base}`,
    `checkout: ${s.checkout}`,
    ...(s.autoResolve ? [`autoResolve: ${s.autoResolve}`] : []),
    '',
  ].join('\n');
}

export async function writePreviewSettings(
  cwd: string,
  settings: PreviewSettings,
): Promise<boolean> {
  const file = path.join(await commonDir(cwd), CONFIG_FILE);
  const next = encode(settings);
  try {
    if ((await fs.readFile(file, 'utf8')) === next) return false;
  } catch {
    // not written yet
  }
  await fs.writeFile(file, next);
  return true;
}

/**
 * Parse, separately from reading, because the CLI's `vscode` shim needs
 * these values SYNCHRONOUSLY inside a config getter. One parser, two
 * readers — the alternative was a second copy of this format living in the
 * shim, which is how the file and its reader drift apart.
 */
export function parsePreviewSettings(raw: string): PreviewSettings | undefined {
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const branch = values.get('branch');
  const base = values.get('base');
  const checkout = values.get('checkout');
  // Partial is useless: a rebuild aimed at a guessed branch or base would
  // reset the wrong checkout. Absent settings mean "ask the editor", not
  // "assume the defaults".
  if (!branch || !base || !checkout) return undefined;
  return { branch, base, checkout, autoResolve: values.get('autoResolve') };
}

export async function readPreviewSettings(
  cwd: string,
): Promise<PreviewSettings | undefined> {
  try {
    return parsePreviewSettings(
      await fs.readFile(path.join(await commonDir(cwd), CONFIG_FILE), 'utf8'),
    );
  } catch {
    return undefined;
  }
}

export async function clearPreviewSettings(cwd: string): Promise<void> {
  await fs
    .rm(path.join(await commonDir(cwd), CONFIG_FILE), { force: true })
    .catch(() => {});
}
