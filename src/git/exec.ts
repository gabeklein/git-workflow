import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Config every git the extension runs carries, children included (env, not
 * `-c`, so a fetch's own subprocesses inherit it). A background fetch or
 * commit must never start git's automatic gc/maintenance in someone's repo:
 * nobody asked for it, it races whatever else is running, and a repack that
 * goes wrong deletes objects. The user's own git still maintains as usual.
 */
export const BACKGROUND_GIT_CONFIG: ReadonlyArray<[string, string]> = [
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
];

function configEnv(): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(BACKGROUND_GIT_CONFIG.length),
  };
  BACKGROUND_GIT_CONFIG.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
    /** stdout emitted before failure (merge-tree prints conflicts here) */
    readonly stdout: string = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export async function git(
  cwd: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        // Stable, script-friendly output
        GIT_TERMINAL_PROMPT: '0',
        LANG: 'C',
        ...configEnv(),
        ...extraEnv,
      },
    });
    return stdout.toString();
  } catch (err: unknown) {
    const e = err as {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      code?: number;
      message?: string;
    };
    const stderr = e.stderr?.toString() ?? '';
    throw new GitError(
      e.message ?? `git ${args.join(' ')} failed`,
      stderr,
      e.code ?? null,
      e.stdout?.toString() ?? '',
    );
  }
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}
