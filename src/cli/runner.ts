import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * How to run a preview operation from a shell.
 *
 * The engine is plain git plumbing, but it is TypeScript bundled for node,
 * and a shell script has no idea where a VS Code extension lives — least
 * of all after an update moves it. So the editor writes the recipe down
 * beside the state it operates on: which node, which bundle. Rewritten on
 * every reconcile, so a moved install heals itself.
 *
 * There is deliberately no resident process. A queue was tried and taken
 * back out: it serialised requests nothing was contending for, since the
 * rebuild lock was already the correctness boundary — and the one thing
 * the queue's claim really added, a NAME for whoever holds it, now lives
 * on the lock itself (see laneLock). What remains is the part that was
 * always load-bearing: an engine a shell can run.
 */

export const RUNNER_FILE = 'focus-runner';

export interface RunnerCommand {
  /** Absolute path to a node — the editor's own, when that is all there is. */
  node: string;
  /** Absolute path to the bundled one-shot CLI. */
  script: string;
}

export async function writeRunnerCommand(
  common: string,
  cmd: RunnerCommand,
): Promise<void> {
  await fs.writeFile(
    path.join(common, RUNNER_FILE),
    [
      '# git-workflow: how to run a preview operation without the editor.',
      '# Generated — rewritten whenever preview is enabled.',
      `node: ${cmd.node}`,
      `script: ${cmd.script}`,
      '',
    ].join('\n'),
  );
}

export async function readRunnerCommand(
  common: string,
): Promise<RunnerCommand | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(common, RUNNER_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const node = values.get('node');
  const script = values.get('script');
  return node && script ? { node, script } : undefined;
}

export async function clearRunnerCommand(common: string): Promise<void> {
  await fs.rm(path.join(common, RUNNER_FILE), { force: true }).catch(() => {});
}
