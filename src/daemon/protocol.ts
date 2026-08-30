import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { commonDir } from '../git/preview/lanes';

/**
 * The preview protocol: what a client asks for, and how it is answered.
 *
 * One process performs preview mutations and everything else asks it to —
 * the editor and an agent by exactly the same route, which is the point.
 * A single writer turns "hold the mutex, hope nobody died holding it" into
 * "get in line", and the queue answers who is driving without anyone
 * inspecting a lock.
 *
 * The transport is a DIRECTORY, not a socket, and that is a deliberate
 * constraint rather than a simplification: `gw-lane` is POSIX sh, and sh
 * cannot speak a unix socket without nc/socat. A socket transport would
 * put a runtime dependency at every call site and hand the editor a
 * private channel agents cannot use — the exact asymmetry this replaces.
 * A request is a file moved into place with rename(2), which is atomic on
 * every filesystem that matters, inspectable with `ls`, and works on a
 * repo mounted over the network.
 *
 *   focus-queue/tmp/<id>    being written (never read by the daemon)
 *   focus-queue/req/<id>    submitted, awaiting the daemon
 *   focus-queue/res/<id>    answered, awaiting its client
 *
 * Same `key: value` text as focus-status, for the same reason: sh writes
 * it with printf and reads it with sed, and a human reading the raw file
 * gets the same words the client did. Nothing here needs a JSON parser.
 */

export const QUEUE_DIR = 'focus-queue';
export const DAEMON_LOCK = 'focus-daemon.lock';
/** Written inside the claim: who is serving, since when. */
export const OWNER_FILE = 'owner';
/** How to start the daemon, recorded while preview is on (see settings). */
export const DAEMON_CMD_FILE = 'focus-daemon-cmd';

export interface QueuePaths {
  common: string;
  queue: string;
  tmp: string;
  req: string;
  res: string;
  lock: string;
  owner: string;
}

export function queuePathsIn(common: string): QueuePaths {
  const queue = path.join(common, QUEUE_DIR);
  const lock = path.join(common, DAEMON_LOCK);
  return {
    common,
    queue,
    tmp: path.join(queue, 'tmp'),
    req: path.join(queue, 'req'),
    res: path.join(queue, 'res'),
    lock,
    owner: path.join(lock, OWNER_FILE),
  };
}

export async function queuePaths(cwd: string): Promise<QueuePaths> {
  return queuePathsIn(await commonDir(cwd));
}

export async function ensureQueue(paths: QueuePaths): Promise<void> {
  for (const dir of [paths.queue, paths.tmp, paths.req, paths.res]) {
    await fs.mkdir(dir, { recursive: true });
  }
}

/* ---------------------------------------------------------------- records */

export type Record_ = Map<string, string>;

export function encodeRecord(entries: [string, string | undefined][]): string {
  return `${entries
    .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== '')
    // Values are one line each: a newline in a message would read back as
    // the next field, so flatten rather than quote — no field here is
    // structured, and a quoting rule is one more thing sh has to implement.
    .map(([k, v]) => `${k}: ${v.replace(/\s+/g, ' ').trim()}`)
    .join('\n')}\n`;
}

/**
 * Every line, in order, repeats included — for the fields that legitimately
 * occur more than once (a `resolved:` per lane). decodeRecord is first-wins
 * and right for scalars; this is right for lists.
 */
export function decodePairs(raw: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    out.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return out;
}

export function decodeRecord(raw: string): Record_ {
  const out = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    // First wins: a repeated key is a client's mistake, not an override
    if (!out.has(key)) out.set(key, line.slice(at + 1).trim());
  }
  return out;
}

/* --------------------------------------------------------------- messages */

export interface PreviewRequest {
  id: string;
  op: string;
  /** Why, for the log and for anyone reading the queue. */
  reason?: string;
  /** Optional operand — a lane name, for the ops that take one. */
  lane?: string;
  clientPid?: number;
  clientHost?: string;
  at?: string;
}

export interface PreviewResponse {
  id: string;
  op: string;
  ok: boolean;
  /** Machine-readable outcome: the rebuild's code, or a protocol one. */
  code?: string;
  message?: string;
  /** Free extra fields (lanes, tree, …) passed through verbatim. */
  extra?: [string, string | undefined][];
}

export function encodeRequest(req: PreviewRequest): string {
  return encodeRecord([
    ['op', req.op],
    ['lane', req.lane],
    ['reason', req.reason],
    ['client-pid', req.clientPid ? String(req.clientPid) : undefined],
    ['client-host', req.clientHost ?? os.hostname()],
    ['at', req.at ?? new Date().toISOString()],
  ]);
}

export function decodeRequest(id: string, raw: string): PreviewRequest {
  const r = decodeRecord(raw);
  return {
    id,
    op: r.get('op') ?? '',
    lane: r.get('lane'),
    reason: r.get('reason'),
    clientPid: Number(r.get('client-pid')) || undefined,
    clientHost: r.get('client-host'),
    at: r.get('at'),
  };
}

export function encodeResponse(res: PreviewResponse): string {
  return encodeRecord([
    ['ok', res.ok ? 'yes' : 'no'],
    ['op', res.op],
    ['code', res.code],
    ['message', res.message],
    ...(res.extra ?? []),
    ['at', new Date().toISOString()],
  ]);
}

export function decodeResponse(id: string, raw: string): PreviewResponse {
  const r = decodeRecord(raw);
  return {
    id,
    op: r.get('op') ?? '',
    ok: r.get('ok') === 'yes',
    code: r.get('code'),
    message: r.get('message'),
    // Pairs, not the map: `resolved:` occurs once per lane
    extra: decodePairs(raw),
  };
}

/* ------------------------------------------------------------------ owner */

export interface DaemonOwner {
  pid: number;
  host: string;
  started: string;
  /** The bundle serving, so a version skew is visible rather than puzzling. */
  script?: string;
}

export function encodeOwner(owner: DaemonOwner): string {
  return encodeRecord([
    ['pid', String(owner.pid)],
    ['host', owner.host],
    ['started', owner.started],
    ['script', owner.script],
  ]);
}

export async function readOwner(
  paths: QueuePaths,
): Promise<DaemonOwner | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(paths.owner, 'utf8');
  } catch {
    return undefined;
  }
  const r = decodeRecord(raw);
  const pid = Number(r.get('pid'));
  if (!pid) return undefined;
  return {
    pid,
    host: r.get('host') ?? '',
    started: r.get('started') ?? '',
    script: r.get('script'),
  };
}

/**
 * Is the recorded owner still alive?
 *
 * Only answerable on the same host — signal 0 tells us about OUR process
 * table and nothing about anyone else's. A claim from another host is
 * therefore never swept here: it is either honoured or reported, because
 * guessing would mean two writers, which is the one thing this design
 * exists to prevent. (A repo shared across hosts wants a lease with a
 * deadline; that is a later problem, and this returns 'unknown' so the
 * caller can say so instead of assuming.)
 */
export function ownerLiveness(
  owner: DaemonOwner | undefined,
): 'none' | 'alive' | 'dead' | 'unknown' {
  if (!owner) return 'none';
  if (owner.host !== os.hostname()) return 'unknown';
  try {
    process.kill(owner.pid, 0);
    return 'alive';
  } catch (err) {
    // EPERM: it exists and belongs to somebody else — alive for our purposes
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : 'dead';
  }
}
