import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DAEMON_CMD_FILE,
  type PreviewResponse,
  type QueuePaths,
  decodeRecord,
  decodeResponse,
  encodeRecord,
  encodeRequest,
  ensureQueue,
  ownerLiveness,
  queuePaths,
  readOwner,
} from './protocol';

/**
 * Asking the daemon for something — the same way from the editor as from
 * a shell.
 *
 * Submit is a write-then-rename into the request directory, so no reader
 * ever sees a partial request, and waiting is polling for a file. Both are
 * things POSIX sh does natively, which is the constraint that keeps this
 * transport honest: whatever the editor can ask for, `gw-lane` can ask for
 * with `mv` and `cat`.
 *
 * Every call can fail to reach a daemon at all, and that is a normal
 * answer rather than an exception — 'unreachable' means the caller should
 * say so (or fall back), never that the preview is fine.
 */

const WAIT_MS = 120_000;
const POLL_MS = 50;

export interface SubmitOptions {
  op: string;
  lane?: string;
  reason?: string;
  /** How long to wait for an answer before giving up. */
  timeoutMs?: number;
  /** Start a daemon when none is serving (default true). */
  spawnIfIdle?: boolean;
}

export type SubmitResult =
  | { kind: 'answered'; response: PreviewResponse }
  | { kind: 'unreachable'; message: string }
  | { kind: 'timeout'; message: string };

/** How to start a daemon for this repo, as the editor recorded it. */
export interface DaemonCommand {
  node: string;
  script: string;
}

export async function readDaemonCommand(
  paths: QueuePaths,
): Promise<DaemonCommand | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(paths.common, DAEMON_CMD_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const r = decodeRecord(raw);
  const node = r.get('node');
  const script = r.get('script');
  return node && script ? { node, script } : undefined;
}

export async function writeDaemonCommand(
  paths: QueuePaths,
  cmd: DaemonCommand,
): Promise<void> {
  await fs.writeFile(
    path.join(paths.common, DAEMON_CMD_FILE),
    `# git-workflow: how to start the preview daemon. Generated.\n${encodeRecord([
      ['node', cmd.node],
      ['script', cmd.script],
    ])}`,
  );
}

/** Is somebody serving this repo right now? */
export async function daemonLiveness(
  paths: QueuePaths,
): Promise<'alive' | 'none' | 'dead' | 'unknown'> {
  return ownerLiveness(await readOwner(paths));
}

/**
 * Start one, detached.
 *
 * Detached and unref'd because the spawner is not its parent in any
 * meaningful sense: an agent's shell exits in a second, the editor may
 * reload, and neither event should take the preview's writer with it. It
 * is safe to call when one is already running — the loser of the claim
 * exits immediately (see main.ts).
 *
 * ELECTRON_RUN_AS_NODE is cleared deliberately: the editor's own binary is
 * a perfectly good node when told to be one, and that is often the only
 * node on the machine, but a daemon inheriting the flag from an editor
 * process would spawn ITS children as node too.
 */
export async function spawnDaemon(paths: QueuePaths): Promise<boolean> {
  const cmd = await readDaemonCommand(paths);
  if (!cmd) return false;
  try {
    // Strip the editor's own Electron/VS Code variables. A child started
    // from an extension host inherits a environment describing a running
    // editor — IPC handles, an NLS config, a parent pid — and an Electron
    // binary told to be node reads several of them. The daemon wants a
    // plain node process, so it is given a plain node environment.
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('ELECTRON_') && !key.startsWith('VSCODE_'))
        env[key] = value;
    }
    env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(cmd.node, [cmd.script, '--common', paths.common], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function submit(
  cwd: string,
  opts: SubmitOptions,
): Promise<SubmitResult> {
  const paths = await queuePaths(cwd);
  await ensureQueue(paths);

  if (opts.spawnIfIdle !== false && (await daemonLiveness(paths)) !== 'alive') {
    if (!(await spawnDaemon(paths))) {
      return {
        kind: 'unreachable',
        message:
          'no preview daemon is running and none could be started (focus-daemon-cmd missing) — is preview on?',
      };
    }
  }

  const id = `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const body = encodeRequest({
    id,
    op: opts.op,
    lane: opts.lane,
    reason: opts.reason,
    clientPid: process.pid,
    clientHost: os.hostname(),
  });
  const tmp = path.join(paths.tmp, id);
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, path.join(paths.req, id));

  const deadline = Date.now() + (opts.timeoutMs ?? WAIT_MS);
  const answer = path.join(paths.res, id);
  while (Date.now() < deadline) {
    let raw: string | undefined;
    try {
      raw = await fs.readFile(answer, 'utf8');
    } catch {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    await fs.rm(answer, { force: true }).catch(() => {});
    return { kind: 'answered', response: decodeResponse(id, raw) };
  }
  // Leave the request in place: it may still be executed, and a rebuild
  // that lands after the client gave up is still the right rebuild.
  return {
    kind: 'timeout',
    message: `no answer within ${Math.round(
      (opts.timeoutMs ?? WAIT_MS) / 1000,
    )}s — the daemon may be busy with a long rebuild`,
  };
}

/**
 * A daemon's answer, as the shape the rest of the extension already
 * speaks.
 *
 * Deliberately lossless in the direction that matters: the auto-resolved
 * lanes come back so the sidebar tags exactly the rows it would have
 * tagged when it ran the rebuild itself. A client that quietly lost them
 * would make "who built it" observable in the UI, which is the whole
 * thing this architecture is trying to make invisible.
 */
export function asRebuildResult(
  res: PreviewResponse,
): import('../git/preview/engine').RebuildResult {
  const value = (key: string) =>
    res.extra?.find(([k]) => k === key)?.[1] ?? '';
  const list = (key: string) =>
    value(key)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (res.ok) {
    return {
      ok: true,
      lanes: list('tree').filter((l) => l !== '(base only)'),
      skipped: list('skipped'),
      landed: list('landed'),
      resolved: (res.extra ?? [])
        .filter(([k]) => k === 'resolved')
        .map(([, v]) => {
          const [lane = '', ...rest] = (v ?? '').split('|');
          const part = (name: string) =>
            (rest.find((p) => p.startsWith(`${name}=`)) ?? '')
              .slice(name.length + 1)
              .split(',')
              .filter(Boolean);
          return { lane, lossless: part('lossless'), lossy: part('lossy') };
        }),
    };
  }
  const code = res.code ?? 'error';
  return {
    ok: false,
    code: (['busy', 'dirty', 'unique', 'conflict', 'moved', 'error'] as const).includes(
      code as 'busy',
    )
      ? (code as 'busy')
      : 'error',
    message: res.message ?? 'the daemon refused without saying why',
    lane: value('lane') || undefined,
  };
}
