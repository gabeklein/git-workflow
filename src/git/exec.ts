import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
