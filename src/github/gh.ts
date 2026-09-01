import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The one place the extension shells out to `gh`.
 *
 * Every PR question costs a GitHub API request against a 5000/hour budget
 * shared with everything else the user runs — `gh` in a terminal, other
 * extensions, CI tokens. So the client owns two things beyond running the
 * subprocess: whether `gh` exists at all (asked once), and whether the
 * budget is currently exhausted.
 *
 * The second matters more than it looks. A refused-for-rate-limit call is
 * indistinguishable, to a caller that only sees `undefined`, from "no PR
 * for this branch" — so the old behaviour was to swallow the 403 and ask
 * again on the next refresh, spending the budget on being told no. A
 * refusal now opens a cooldown: nothing asks again until it lapses, and the
 * panels keep showing the last answer they had rather than dropping badges.
 */
export type GhJson = <T>(
  cwd: string,
  args: string[],
  timeoutMs?: number,
) => Promise<T | undefined>;

/** How long to stop asking after GitHub refuses for rate limit. */
const RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;

let ghAvailable: boolean | undefined;
let ghCheckInFlight: Promise<boolean> | undefined;
let cooldownUntil = 0;

/** True when gh refused because the API budget is spent (primary or secondary). */
export function isRateLimitRefusal(message: string): boolean {
  return /rate limit/i.test(message);
}

/** Milliseconds until PR queries are worth trying again; 0 when they are. */
export function rateLimitCooldownRemaining(now = Date.now()): number {
  return Math.max(0, cooldownUntil - now);
}

/** Forget the cooldown and the cached gh probe (explicit refresh, config change). */
export function resetGithubPrClient(): void {
  ghAvailable = undefined;
  ghCheckInFlight = undefined;
  cooldownUntil = 0;
}

/** Whether `gh` is on PATH. Probed once — the answer does not change mid-session. */
export async function isGhAvailable(): Promise<boolean> {
  if (ghAvailable !== undefined) return ghAvailable;
  if (ghCheckInFlight) return ghCheckInFlight;
  ghCheckInFlight = (async () => {
    try {
      await execFileAsync('gh', ['--version'], {
        timeout: 4000,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      });
      ghAvailable = true;
    } catch {
      ghAvailable = false;
    } finally {
      ghCheckInFlight = undefined;
    }
    return ghAvailable;
  })();
  return ghCheckInFlight;
}

/**
 * Run `gh ... --json ...` and parse it. `undefined` for every failure —
 * callers cannot act on the difference — except that a rate-limit refusal
 * also opens the cooldown, and is reported so the log says why badges
 * stopped moving.
 */
export function createGhJson(log?: {
  appendLine(value: string): void;
}): GhJson {
  return async function ghJson<T>(
    cwd: string,
    args: string[],
    timeoutMs = 20_000,
  ): Promise<T | undefined> {
    if (rateLimitCooldownRemaining() > 0) return undefined;
    try {
      const { stdout } = await execFileAsync('gh', args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
        },
      });
      const text = stdout.toString().trim();
      if (!text) return undefined;
      return JSON.parse(text) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stderr =
        typeof (err as { stderr?: unknown })?.stderr === 'string'
          ? (err as { stderr: string }).stderr
          : '';
      if (isRateLimitRefusal(`${message}\n${stderr}`)) {
        cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        log?.appendLine(
          `GitHub API rate limit reached — PR lookups paused for ${
            RATE_LIMIT_COOLDOWN_MS / 60_000
          } minutes (last answers kept)`,
        );
      }
      return undefined;
    }
  };
}
