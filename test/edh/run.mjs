#!/usr/bin/env node
/**
 * Live EDH validation: boots a real VS Code Extension Development Host on a
 * generated sample repo and runs the mocha scenarios beside this file
 * INSIDE the extension host, driving the extension's registered commands
 * and asserting on real git state. `npm run test:edh`.
 *
 * The scenarios are sequential and build on each other — index.ts runs
 * the files in its explicit ORDER and bails on the first failure.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Sample project: main + one feature lane (worktree) + preview checkout. */
function buildFixture() {
  // realpath: on macOS tmpdir() is /var/…, a symlink to /private/var/… —
  // git reports realpaths, and the extension compares paths literally
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gw-edh-')));
  const repo = path.join(root, 'sample');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'edh@test']);
  git(repo, ['config', 'user.name', 'edh']);
  writeFileSync(path.join(repo, 'app.txt'), 'line1\nline2\nline3\n');
  writeFileSync(path.join(repo, 'README.md'), '# sample\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);

  // Bare origin so landing/fetch flows are real
  const origin = path.join(root, 'origin.git');
  git(root, ['init', '-q', '-b', 'main', '--bare', 'origin.git']);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-qu', 'origin', 'main']);

  // Feature lanes with worktrees under .worktrees (the default layout)
  git(repo, ['branch', 'feat/a']);
  git(repo, ['worktree', 'add', '-q', '.worktrees/feat-a', 'feat/a']);
  const laneA = path.join(repo, '.worktrees', 'feat-a');
  writeFileSync(path.join(laneA, 'a.txt'), 'from feat/a\n');
  git(laneA, ['add', 'a.txt']);
  git(laneA, ['commit', '-qm', 'feat a']);
  git(repo, ['push', '-q', 'origin', 'feat/a']);

  git(repo, ['branch', 'feat/b']);
  git(repo, ['worktree', 'add', '-q', '.worktrees/feat-b', 'feat/b']);
  const laneB = path.join(repo, '.worktrees', 'feat-b');
  writeFileSync(path.join(laneB, 'b.txt'), 'from feat/b\n');
  git(laneB, ['add', 'b.txt']);
  git(laneB, ['commit', '-qm', 'feat b']);
  git(repo, ['push', '-q', 'origin', 'feat/b']);

  // A second clone stands in for "the GitHub side" where PRs land
  git(root, ['clone', '-q', origin, 'landing']);
  const landing = path.join(root, 'landing');
  git(landing, ['config', 'user.email', 'edh@test']);
  git(landing, ['config', 'user.name', 'edh']);

  // Preview mode on, the only way it can be: the ROOT checkout switched
  // to the default preview branch name.
  git(repo, ['checkout', '-q', '-b', 'preview/main', 'main']);
  // ...which leaves main without a checkout, so it gets a worktree like
  // any other branch. Scenarios need it: absorb rescues work INTO the
  // base's checkout, and base drift is a commit somebody made on main.
  git(repo, ['worktree', 'add', '-q', '.worktrees/main', 'main']);

  // Keep checkouts out of status, like the extension's creation paths do
  writeFileSync(
    path.join(repo, '.git', 'info', 'exclude'),
    '/.worktrees/\n',
  );

  // The landed sweep is OFF for the suite at large, and ON only in the
  // scenario that is about it. Otherwise it does its job on the fixture's
  // own landed lanes — feat/b is deliberately landed by landing.test.ts —
  // and removes folders that every later scenario still expects to exist.
  mkdirSync(path.join(repo, '.vscode'), { recursive: true });
  writeFileSync(
    path.join(repo, '.vscode', 'settings.json'),
    `${JSON.stringify({ 'worktreeCompare.autoRemoveLandedWorktrees': false }, null, 2)}\n`,
  );
  return { root, repo };
}

/** Compile the .ts beside this file → out-test/edh/*.cjs for the EDH. */
async function buildTests() {
  const outDir = path.resolve(extensionDevelopmentPath, 'out-test', 'edh');
  // Stale compiled tests would trip index.ts's ORDER sync check (or worse,
  // silently run deleted scenarios) — always build into a clean dir.
  rmSync(outDir, { recursive: true, force: true });
  const entryPoints = readdirSync(__dirname)
    .filter((f) => f === 'index.ts' || f.endsWith('.test.ts'))
    .map((f) => path.join(__dirname, f));
  await build({
    entryPoints,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['vscode', 'mocha'],
    outdir: outDir,
    outExtension: { '.js': '.cjs' },
    sourcemap: 'inline',
    logLevel: 'error',
  });
  return path.join(outDir, 'index.cjs');
}

const extensionTestsPath = await buildTests();
const { root, repo } = buildFixture();
console.log(`[edh-test] fixture: ${repo}`);

// When this script itself runs from inside a VS Code terminal / extension
// host, Electron/VS Code env vars leak into the spawned EDH and make its
// Electron run as plain Node (ELECTRON_RUN_AS_NODE) or confuse startup.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ELECTRON_') || key.startsWith('VSCODE_')) {
    delete process.env[key];
  }
}

try {
  await runTests({
    // Pinned: CI resolves 'stable' over the network each run (flaky) and a
    // moving target would silently change what we test against.
    version: '1.134.0',
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      repo,
      // Keep the user-data dir SHORT and outside the checkout: it holds the
      // IPC socket, and macOS caps that path at 103 chars — the default
      // (<checkout>/.vscode-test/user-data) blows past it from a worktree,
      // which is exactly where this project gets developed.
      `--user-data-dir=${path.join(tmpdir(), 'gw-edh-ud')}`,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-gpu',
    ],
    extensionTestsEnv: {
      GW_FIXTURE_REPO: repo,
      GW_TEST_HOOKS: '1',
      GW_FIXTURE_LANDING: path.join(root, 'landing'),
    },
  });
  console.log('[edh-test] PASS');
} catch (err) {
  console.error('[edh-test] FAIL:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
