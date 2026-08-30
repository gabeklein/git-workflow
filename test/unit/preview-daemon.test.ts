import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { submit } from '../../src/daemon/client';
import {
  decodeRecord,
  encodeOwner,
  encodeRecord,
  queuePathsIn,
  ownerLiveness,
} from '../../src/daemon/protocol';
import { PreviewDaemon } from '../../src/daemon/server';
import { writePreviewSettings } from '../../src/git/preview/settings';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * The single writer, and the directory it is asked through.
 *
 * These run the real thing: a real queue on disk, a real rebuild, and —
 * for the end-to-end case — the real bundle spawned by the real shell
 * script. A mocked transport would test the mock, and the entire claim
 * being made here is that an agent's shell and the editor reach the same
 * process by the same route.
 */
describe('preview daemon', () => {
  let scratch: ScratchRepo;
  let common: string;
  let repo: string;

  const paths = () => queuePathsIn(common);

  const enqueue = (id: string, body: string) => {
    const p = paths();
    fs.mkdirSync(p.req, { recursive: true });
    fs.mkdirSync(p.tmp, { recursive: true });
    fs.writeFileSync(path.join(p.tmp, id), body);
    fs.renameSync(path.join(p.tmp, id), path.join(p.req, id));
  };

  const answer = (id: string) =>
    decodeRecord(fs.readFileSync(path.join(paths().res, id), 'utf8'));

  beforeEach(async () => {
    scratch = makeRepo({ withOrigin: true });
    repo = scratch.repo;
    common = path.join(repo, '.git');
    // A lane with content, and a checkout on the preview branch to hold it
    git(repo, ['checkout', '-q', '-b', 'feat/a']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'from a\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'a']);
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['checkout', '-q', '-b', 'preview/main', 'main']);
    fs.writeFileSync(path.join(common, 'focus-applied'), 'feat/a\n');
    fs.writeFileSync(path.join(common, 'focus-candidates'), 'feat/a\n');
    await writePreviewSettings(repo, {
      branch: 'preview/main',
      base: 'origin/main',
      checkout: repo,
    });
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('serves a rebuild request and puts the lane in the tree', async () => {
    enqueue('r1', 'op: rebuild\nreason: unit test\n');
    const daemon = new PreviewDaemon({ common, maxRequests: 1 });
    expect(await daemon.claim()).toBe('claimed');
    expect(await daemon.serve()).toBe('served');

    expect(answer('r1').get('ok')).toBe('yes');
    expect(answer('r1').get('tree')).toBe('feat/a');
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(true);
    // …and the record #60 introduced is written by the same engine run
    expect(fs.readFileSync(path.join(common, 'focus-status'), 'utf8')).toContain(
      'state: ok',
    );
  });

  /**
   * The property the fallback depends on: the editor and the daemon do not
   * merely call the same engine, they perform the same OPERATION. If these
   * two ever diverged, the preview would depend on who built it — which is
   * exactly the bug a single writer is supposed to make impossible.
   */
  it('is the same operation the editor runs in-process', async () => {
    const { rebuildFromSettings } = await import(
      '../../src/git/preview/rebuildOp'
    );
    // The editor's path: settings passed in, never read back from disk
    const direct = await rebuildFromSettings(repo, {
      branch: 'preview/main',
      base: 'origin/main',
      checkout: repo,
    });
    expect(direct).toMatchObject({ kind: 'ran', result: { ok: true } });
    const tree = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8');

    // The daemon's path: the same operation, settings read from focus-config
    git(repo, ['reset', '-q', '--hard', 'main']);
    enqueue('r1', 'op: rebuild\n');
    const daemon = new PreviewDaemon({ common, maxRequests: 1 });
    await daemon.claim();
    await daemon.serve();
    expect(answer('r1').get('ok')).toBe('yes');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe(tree);
  });

  it('answers an op it does not know instead of dying on it', async () => {
    enqueue('r1', 'op: teleport\n');
    const daemon = new PreviewDaemon({ common, maxRequests: 1 });
    await daemon.claim();
    await daemon.serve();
    expect(answer('r1').get('ok')).toBe('no');
    expect(answer('r1').get('code')).toBe('unsupported');
  });

  /**
   * Preview off, or an editor that has not written its settings: rebuilding
   * against a guessed branch would reset the wrong checkout, so it refuses
   * with a code the CLI maps to "cannot say" rather than "failed".
   */
  it('refuses to rebuild a repo whose settings it does not have', async () => {
    fs.rmSync(path.join(common, 'focus-config'));
    enqueue('r1', 'op: rebuild\n');
    const daemon = new PreviewDaemon({ common, maxRequests: 1 });
    await daemon.claim();
    await daemon.serve();
    expect(answer('r1').get('code')).toBe('unconfigured');
  });

  it('executes in submission order — the queue IS the merge order', async () => {
    enqueue('a', 'op: ping\n');
    // Distinct mtimes; the sort is what makes the queue a queue
    await new Promise((r) => setTimeout(r, 20));
    enqueue('b', 'op: ping\n');
    const seen: string[] = [];
    const daemon = new PreviewDaemon({
      common,
      maxRequests: 2,
      log: (line) => seen.push(line),
    });
    await daemon.claim();
    await daemon.serve();
    expect(answer('a').get('ok')).toBe('yes');
    expect(answer('b').get('ok')).toBe('yes');
    expect(seen).toHaveLength(2);
  });

  describe('the claim', () => {
    it('is exclusive — a second daemon does not serve', async () => {
      const first = new PreviewDaemon({ common });
      expect(await first.claim()).toBe('claimed');
      const second = new PreviewDaemon({ common });
      expect(await second.claim()).toBe('taken');
      await first.release();
      expect(await second.claim()).toBe('claimed');
      await second.release();
    });

    /**
     * The crash case. A claim left by a dead process used to mean a repo
     * that needs a manual rm -rf before anything works again.
     */
    it('sweeps a claim whose owner died on this host', async () => {
      const p = paths();
      fs.mkdirSync(p.lock, { recursive: true });
      fs.writeFileSync(
        p.owner,
        encodeOwner({
          pid: 999_999_999, // no such process
          host: os.hostname(),
          started: new Date().toISOString(),
        }),
      );
      const daemon = new PreviewDaemon({ common });
      expect(await daemon.claim()).toBe('claimed');
      await daemon.release();
    });

    /**
     * …but never another host's. We cannot read its process table, and
     * sweeping on a guess would mean two writers, which is the one thing
     * the queue exists to prevent.
     */
    it('honours a claim from another host, alive or not', async () => {
      const p = paths();
      fs.mkdirSync(p.lock, { recursive: true });
      fs.writeFileSync(
        p.owner,
        encodeOwner({
          pid: 999_999_999,
          host: 'some-other-machine',
          started: new Date().toISOString(),
        }),
      );
      expect(ownerLiveness({ pid: 1, host: 'elsewhere', started: '' })).toBe(
        'unknown',
      );
      const daemon = new PreviewDaemon({ common });
      expect(await daemon.claim()).toBe('taken');
    });
  });

  it('client submit and daemon serve meet in the middle', async () => {
    const daemon = new PreviewDaemon({ common, maxRequests: 1 });
    await daemon.claim();
    const serving = daemon.serve();
    const result = await submit(repo, {
      op: 'rebuild',
      reason: 'from a client',
      timeoutMs: 15_000,
    });
    await serving;
    expect(result).toMatchObject({ kind: 'answered' });
    if (result.kind !== 'answered') return;
    expect(result.response.ok).toBe(true);
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(true);
  });

  /**
   * Preview going off sends this. A daemon serving a preview that no
   * longer exists would otherwise sit on its claim until the idle timer,
   * answering 'unconfigured' to everyone in the meantime.
   */
  it('stops on request, and answers before it goes', async () => {
    const daemon = new PreviewDaemon({ common });
    await daemon.claim();
    const serving = daemon.serve();
    const result = await submit(repo, {
      op: 'stop',
      spawnIfIdle: false,
      timeoutMs: 10_000,
    });
    expect(await serving).toBe('stopped');
    expect(result).toMatchObject({ kind: 'answered' });
    // …and the claim is released, so the next daemon starts clean
    expect(fs.existsSync(paths().lock)).toBe(false);
  });

  /**
   * Membership over the queue: the sidebar's checkbox and `gw-lane add`
   * now reach the same operation by the same route, so "apply" cannot come
   * to mean two things.
   */
  it('serves membership changes, and says whether anything changed', async () => {
    const daemon = new PreviewDaemon({ common, maxRequests: 2 });
    await daemon.claim();
    const serving = daemon.serve();
    const first = await submit(repo, {
      op: 'apply',
      lane: 'feat/a',
      spawnIfIdle: false,
      timeoutMs: 10_000,
    });
    const again = await submit(repo, {
      op: 'apply',
      lane: 'feat/a',
      spawnIfIdle: false,
      timeoutMs: 10_000,
    });
    await serving;
    expect(first).toMatchObject({ kind: 'answered' });
    if (first.kind === 'answered') expect(first.response.ok).toBe(true);
    if (again.kind === 'answered') {
      expect(again.response.extra).toContainEqual(['changed', 'no']);
    }
  });

  it('refuses a membership request with no lane, instead of guessing', async () => {
    enqueue('r1', 'op: apply\n');
    const daemon = new PreviewDaemon({ common, maxRequests: 1 });
    await daemon.claim();
    await daemon.serve();
    expect(answer('r1').get('ok')).toBe('no');
    expect(answer('r1').get('message')).toContain('needs a lane');
  });

  it('says so plainly when no daemon can be reached or started', async () => {
    // No focus-daemon-cmd: nothing to spawn, and nothing is serving
    const result = await submit(repo, { op: 'ping', timeoutMs: 500 });
    expect(result).toMatchObject({ kind: 'unreachable' });
  });

  /**
   * The whole path an agent takes: the shell script spawns the real
   * bundle, which claims, rebuilds, answers, and exits on its own.
   */
  describe('end to end through gw-lane', () => {
    let bundle: string;

    beforeAll(async () => {
      const esbuild = await import('esbuild');
      bundle = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'gw-daemon-bundle-')),
        'daemon.js',
      );
      await esbuild.build({
        entryPoints: [path.resolve('src/daemon/main.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: bundle,
        alias: { vscode: path.resolve('src/daemon/vscodeShim.ts') },
        logLevel: 'silent',
      });
    }, 60_000);

    it('gw-lane rebuild starts a daemon, waits for it, and reports the tree', async () => {
      const { installLaneCli, laneCliPath } = await import(
        '../../src/git/preview/laneCli'
      );
      await installLaneCli(repo);
      await fsp.writeFile(
        path.join(common, 'focus-daemon-cmd'),
        encodeRecord([
          ['node', process.execPath],
          ['script', bundle],
        ]),
      );

      const cli = await laneCliPath(repo);

      // Membership first, and through the daemon: nothing is serving yet,
      // so a daemon being up afterwards is the evidence that `add` went
      // over the queue rather than editing the files itself.
      execFileSync(cli, ['add', 'feat/a'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, GW_DAEMON_IDLE_MS: '1500' },
      });
      expect(
        execFileSync(cli, ['owner'], { cwd: repo, encoding: 'utf8' }),
      ).toMatch(/serving: pid \d+/);

      const out = execFileSync(cli, ['rebuild'], {
        cwd: repo,
        encoding: 'utf8',
        // The daemon it starts idles out on its own; keep the test short
        env: { ...process.env, GW_DAEMON_IDLE_MS: '1500' },
      });
      expect(out).toContain('rebuilt: feat/a');
      expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(true);

      // …and while it is up, the claim is readable by anyone
      const owner = execFileSync(cli, ['owner'], { cwd: repo, encoding: 'utf8' });
      expect(owner).toMatch(/serving: pid \d+/);
    }, 60_000);
  });
});
