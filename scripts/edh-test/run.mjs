#!/usr/bin/env node
/**
 * Live EDH validation: boots a real VS Code Extension Development Host on a
 * generated sample repo and runs scripts/edh-test/suite.cjs INSIDE the
 * extension host, driving the extension's registered commands and asserting
 * on real git state. `npm run test:edh`.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Sample project: main + one feature lane (worktree) + integration checkout. */
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
  git(root, ['init', '-q', '--bare', 'origin.git']);
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

  // Integration checkout on the default branch name (integration/main)
  git(repo, [
    'worktree',
    'add',
    '-q',
    '.worktrees/working',
    '-b',
    'integration/main',
    'main',
  ]);

  // Keep checkouts out of status, like the extension's creation paths do
  writeFileSync(
    path.join(repo, '.git', 'info', 'exclude'),
    '/.worktrees/\n',
  );
  return { root, repo };
}

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
    extensionDevelopmentPath,
    extensionTestsPath: path.join(__dirname, 'suite.cjs'),
    launchArgs: [
      repo,
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
  console.error(`[edh-test] FAIL: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
