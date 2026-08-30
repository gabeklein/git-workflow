import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isLaneOp, runLaneOp } from '../git/preview/laneOp';
import { readPreviewSettings } from '../git/preview/settings';
import { rebuildFromSettings } from '../git/preview/rebuildOp';
import {
  type PreviewRequest,
  type PreviewResponse,
  type QueuePaths,
  decodeRequest,
  encodeOwner,
  encodeResponse,
  ensureQueue,
  ownerLiveness,
  queuePathsIn,
  readOwner,
} from './protocol';

/**
 * The single writer.
 *
 * Every preview mutation goes through one process, so exclusion stops
 * being something each participant has to get right and becomes a
 * property of the design: requests are executed one at a time, in the
 * order they were submitted, by whoever holds the claim. The editor
 * submits the same requests an agent does, over the same queue, and gets
 * the same answers — no private path, no privileged client.
 *
 * It still takes the rebuild lock the engine has always taken. The lock
 * remains the correctness boundary (an older client, a hook, or the
 * editor's own fallback can still act directly), and the daemon is the
 * coordination layer on top. That is what makes adopting this safe
 * incrementally rather than a flag day.
 *
 * It exits when idle. A resident process nobody is using is a liability —
 * something to notice, kill, and wonder about after an update — and the
 * next request starts a fresh one, so the only cost of exiting is the
 * warm chain cache, which is exactly what an idle repo does not need.
 */

const POLL_MS = 100;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

export interface DaemonOptions {
  /** Any path inside the repo; the git common dir is derived from it. */
  common: string;
  idleMs?: number;
  log?: (line: string) => void;
  /** Stop after this many requests — tests, mostly. */
  maxRequests?: number;
}

export class PreviewDaemon {
  private readonly paths: QueuePaths;
  private readonly idleMs: number;
  private readonly log: (line: string) => void;
  private claimed = false;
  private stopping = false;
  private lastActivity = Date.now();
  private served = 0;
  private watcher: fsSync.FSWatcher | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly opts: DaemonOptions) {
    this.paths = queuePathsIn(opts.common);
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Take the claim, or report who has it.
   *
   * A claim whose owner died on THIS host is swept — that is the ordinary
   * crash case and leaving it would mean a repo that needs a manual
   * `rm -rf` to work again. A claim from another host is never swept: we
   * cannot see its process table, and guessing wrong means two writers.
   */
  async claim(): Promise<'claimed' | 'taken'> {
    await ensureQueue(this.paths);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.mkdir(this.paths.lock);
      } catch {
        const owner = await readOwner(this.paths);
        const liveness = ownerLiveness(owner);
        if (liveness === 'dead' && attempt === 0) {
          this.log(
            `sweeping a claim whose owner (pid ${owner?.pid}) is gone`,
          );
          await fs.rm(this.paths.lock, { recursive: true, force: true });
          continue;
        }
        return 'taken';
      }
      await fs.writeFile(
        this.paths.owner,
        encodeOwner({
          pid: process.pid,
          host: os.hostname(),
          started: new Date().toISOString(),
          script: process.argv[1],
        }),
      );
      this.claimed = true;
      return 'claimed';
    }
    return 'taken';
  }

  async release(): Promise<void> {
    if (!this.claimed) return;
    this.claimed = false;
    await fs.rm(this.paths.lock, { recursive: true, force: true }).catch(() => {});
  }

  /** Serve until idle (or maxRequests). Returns why it stopped. */
  async serve(): Promise<'idle' | 'stopped' | 'served'> {
    // An event wakes it immediately; the interval is the belt for
    // filesystems that drop them (network mounts, some container layers),
    // where a preview that only rebuilt when someone looked would be worse
    // than one that is a quarter-second late.
    try {
      this.watcher = fsSync.watch(this.paths.req, () => this.wake?.());
    } catch {
      this.watcher = undefined;
    }
    try {
      while (!this.stopping) {
        const pending = await this.pending();
        if (pending.length > 0) {
          this.lastActivity = Date.now();
          for (const id of pending) {
            await this.handle(id);
            this.served++;
            if (this.opts.maxRequests && this.served >= this.opts.maxRequests)
              return 'served';
          }
          this.lastActivity = Date.now();
          continue;
        }
        if (Date.now() - this.lastActivity > this.idleMs) return 'idle';
        await this.idleTick();
      }
      return 'stopped';
    } finally {
      this.watcher?.close();
      this.watcher = undefined;
      await this.release();
    }
  }

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }

  private idleTick(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, POLL_MS);
      this.wake = done;
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /** Submitted requests, oldest first — the queue IS the order. */
  private async pending(): Promise<string[]> {
    const names = await fs.readdir(this.paths.req).catch((): string[] => []);
    const stamped: [string, number][] = [];
    for (const name of names) {
      const stat = await fs
        .stat(path.join(this.paths.req, name))
        .catch(() => undefined);
      if (stat) stamped.push([name, stat.mtimeMs]);
    }
    return stamped.sort((a, b) => a[1] - b[1]).map(([name]) => name);
  }

  private async handle(id: string): Promise<void> {
    const file = path.join(this.paths.req, id);
    let request: PreviewRequest;
    try {
      request = decodeRequest(id, await fs.readFile(file, 'utf8'));
    } catch {
      await fs.rm(file, { force: true }).catch(() => {});
      return;
    }
    // Consume BEFORE executing: a request that crashes the daemon must not
    // be retried forever by the next one to start. The client's timeout is
    // what covers the lost answer, and losing one answer beats a repo that
    // cannot start a daemon at all.
    await fs.rm(file, { force: true }).catch(() => {});
    const started = Date.now();
    const response = await this.execute(request);
    this.log(
      `${request.op}${request.lane ? ` ${request.lane}` : ''} → ${
        response.ok ? 'ok' : `failed (${response.code})`
      } in ${Date.now() - started}ms${
        request.reason ? ` · ${request.reason}` : ''
      }`,
    );
    await this.respond(response);
  }

  private async execute(req: PreviewRequest): Promise<PreviewResponse> {
    const base = { id: req.id, op: req.op };
    switch (req.op) {
      case 'ping':
        return { ...base, ok: true, extra: [['pid', String(process.pid)]] };
      case 'stop':
        // Answer first, exit after: the loop re-checks this on its way
        // round, so the client gets a reply rather than a timeout. Preview
        // going off sends this — a daemon serving a preview that no longer
        // exists would otherwise hold its claim until the idle timer.
        this.stopping = true;
        return { ...base, ok: true, extra: [['pid', String(process.pid)]] };
      case 'rebuild':
        return this.rebuild(req);
      case 'apply':
      case 'unapply':
      case 'remove':
      case 'candidate':
        return this.membership(req);
      default:
        return {
          ...base,
          ok: false,
          code: 'unsupported',
          message: `this daemon does not know how to ${req.op || '(nothing)'}`,
        };
    }
  }

  /**
   * Who is in the preview. Deliberately does NOT rebuild: membership and
   * the tree are separate questions, and a client that wants both says so
   * in two requests — which the queue then serialises anyway. Folding a
   * rebuild in here would make every checkbox toggle wait for one.
   */
  private async membership(req: PreviewRequest): Promise<PreviewResponse> {
    const base = { id: req.id, op: req.op };
    if (!req.lane) {
      return { ...base, ok: false, code: 'error', message: `${req.op} needs a lane` };
    }
    if (!isLaneOp(req.op)) {
      return { ...base, ok: false, code: 'unsupported', message: req.op };
    }
    // The repo whose lanes these are: the checkout the editor recorded,
    // falling back to the common dir when preview is off (leaving is
    // allowed then; joining will fail on its own for want of a branch).
    const settings = await readPreviewSettings(this.opts.common);
    const result = await runLaneOp(
      settings?.checkout ?? this.opts.common,
      req.op,
      req.lane,
    );
    if (!result.ok) {
      return { ...base, ok: false, code: result.code, message: result.message };
    }
    return {
      ...base,
      ok: true,
      extra: [
        ['lane', result.lane],
        ['changed', result.changed ? 'yes' : 'no'],
      ],
    };
  }

  private async rebuild(req: PreviewRequest): Promise<PreviewResponse> {
    const base = { id: req.id, op: req.op };
    const outcome = await rebuildFromSettings(this.opts.common);
    if (outcome.kind === 'unconfigured') {
      return { ...base, ok: false, code: 'unconfigured', message: outcome.message };
    }
    const result = outcome.result;
    if (result.ok) {
      return {
        ...base,
        ok: true,
        extra: [
          ['tree', result.lanes.join(', ') || '(base only)'],
          ['skipped', result.skipped.join(', ') || undefined],
          ['landed', result.landed.join(', ') || undefined],
          // One line per lane the resolver settled, so the client can tag
          // the same rows it would have tagged in-process. Pipe-separated
          // because a path may contain spaces.
          ...result.resolved.map(
            (r) =>
              [
                'resolved',
                `${r.lane}|lossless=${r.lossless.join(',')}|lossy=${r.lossy.join(',')}`,
              ] as [string, string],
          ),
        ],
      };
    }
    return {
      ...base,
      ok: false,
      code: result.code,
      message: result.message,
      extra: [['lane', result.lane]],
    };
  }

  private async respond(res: PreviewResponse): Promise<void> {
    const body = encodeResponse(res);
    const tmp = path.join(this.paths.tmp, `res-${res.id}`);
    await fs.writeFile(tmp, body);
    // Rename into place: a client polling for the file never sees a
    // half-written one, on any filesystem worth supporting.
    await fs.rename(tmp, path.join(this.paths.res, res.id));
  }
}
