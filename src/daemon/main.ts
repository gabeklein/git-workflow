import { PreviewDaemon } from './server';
import type { PreviewSettings } from '../git/preview/settings';
import { primeConfiguration } from './vscodeShim';

/**
 * The daemon's entry point — the bundle `gw-lane` and the editor spawn.
 *
 * Deliberately thin: everything interesting is in server.ts, which is
 * plain node and testable in-process. This file exists to translate argv
 * into options, keep the `vscode` shim primed from the settings the
 * editor recorded, and exit quietly when the claim belongs to somebody
 * else — being second is the normal case, not an error, since any client
 * may start one.
 */

function arg(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}

function prime(settings: PreviewSettings): void {
  primeConfiguration([
    ['worktreeCompare.previewBranch', settings.branch],
    ['worktreeCompare.previewBaseRef', settings.base],
    ...(settings.autoResolve
      ? ([['worktreeCompare.previewAutoResolve', settings.autoResolve]] as [
          string,
          unknown,
        ][])
      : []),
  ]);
}

async function main(): Promise<number> {
  const common = arg('common') ?? process.cwd();
  const idle = Number(arg('idle', process.env.GW_DAEMON_IDLE_MS)) || undefined;
  const verbose = process.argv.includes('--verbose');
  const daemon = new PreviewDaemon({
    common,
    idleMs: idle,
    onSettings: prime,
    log: (line) => {
      if (verbose) process.stdout.write(`[gw-daemon] ${line}\n`);
    },
  });

  if ((await daemon.claim()) === 'taken') {
    // Somebody is already serving this repo. Whoever spawned us will have
    // their request answered by them; saying so on stdout is for a human
    // running it by hand.
    if (verbose) process.stdout.write('[gw-daemon] another daemon holds this repo\n');
    return 0;
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      daemon.stop();
    });
  }
  // A crash must not leave the claim behind for the next start to sweep.
  process.on('exit', () => {
    void daemon.release();
  });

  const why = await daemon.serve();
  if (verbose) process.stdout.write(`[gw-daemon] exiting (${why})\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[gw-daemon] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
