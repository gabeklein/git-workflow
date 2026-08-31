import * as fs from 'node:fs';
import * as path from 'node:path';
import { isLaneOp, runLaneOp } from '../git/preview/laneOp';
import { rebuildFromSettings } from '../git/preview/rebuildOp';
import { CONFIG_FILE, parsePreviewSettings } from '../git/preview/settings';
import { resolveConfigurationWith } from './vscodeShim';

/**
 * One preview operation, then exit.
 *
 * There is no resident process and nothing to connect to: `gw-lane` runs
 * this, it takes the same lock the editor's rebuild takes, does the work,
 * prints a line, and goes. Exclusion comes from the lock — which is where
 * it always came from — so two of these racing is simply one waiting.
 *
 * Exit codes are the CLI's contract, and match `gw-lane check`:
 *   0  it happened
 *   1  the operation ran and failed (a conflicting rebuild)
 *   2  it could not run at all (preview off, no settings, lock busy)
 * The distinction is the point: "the preview is broken" and "I could not
 * look" must never arrive as the same answer.
 */

/**
 * argv, split into flags and positionals. A flag CONSUMES the token after
 * it — filtering out only the tokens that start with `--` left the common
 * dir sitting in first position, where the operation should be, and the
 * CLI dutifully reported the path as an unknown operation.
 */
function parseArgv(argv: string[]): {
  flags: Map<string, string>;
  positional: string[];
} {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token.startsWith('--')) {
      flags.set(token.slice(2), argv[++i] ?? '');
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

/**
 * Serve the engine's config reads from what the editor recorded, resolved
 * per read: a renamed branch or changed base takes effect on the next run,
 * with no snapshot to go stale.
 */
function configurationFor(common: string) {
  return (key: string): unknown => {
    let settings;
    try {
      settings = parsePreviewSettings(
        fs.readFileSync(path.join(common, CONFIG_FILE), 'utf8'),
      );
    } catch {
      return undefined;
    }
    if (!settings) return undefined;
    switch (key) {
      case 'worktreeCompare.previewBranch':
        return settings.branch;
      case 'worktreeCompare.previewBaseRef':
        return settings.base;
      case 'worktreeCompare.previewAutoResolve':
        return settings.autoResolve;
      default:
        return undefined;
    }
  };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string, code: 1 | 2): number {
  process.stderr.write(`${line}\n`);
  return code;
}

async function main(): Promise<number> {
  const { flags, positional } = parseArgv(process.argv.slice(2));
  const common = flags.get('common') || process.cwd();
  const [op, lane] = positional;
  if (!op) return fail('usage: <op> [lane] --common <git-common-dir>', 2);
  resolveConfigurationWith(configurationFor(common));

  if (op === 'rebuild') {
    const outcome = await rebuildFromSettings(common);
    if (outcome.kind === 'unconfigured') return fail(outcome.message, 2);
    const result = outcome.result;
    if (result.ok) {
      out(`rebuilt: ${result.lanes.join(', ') || '(base only)'}`);
      for (const r of result.resolved) {
        if (r.lossy.length > 0)
          out(`  auto-resolved toward ${r.lane}, hunks dropped in ${r.lossy.join(' ')}`);
      }
      return 0;
    }
    // 'busy' is not a broken preview — somebody else is mid-write.
    return fail(
      `rebuild failed: ${result.code}${result.message ? ` — ${result.message}` : ''}`,
      result.code === 'busy' ? 2 : 1,
    );
  }

  if (isLaneOp(op)) {
    if (!lane) return fail(`${op} needs a lane`, 2);
    const result = await runLaneOp(common, op, lane);
    if (!result.ok) return fail(result.message, 2);
    out(
      op === 'remove'
        ? `${lane} is out of the preview`
        : op === 'unapply'
          ? `${lane} is no longer applied`
          : op === 'candidate'
            ? `${lane} is offered in the preview`
            : `${lane} is in the preview`,
    );
    return 0;
  }

  return fail(`unknown operation: ${op}`, 2);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  },
);
