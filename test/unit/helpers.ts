/**
 * Scratch-repo builder for unit tests: a real git repo (plus optional bare
 * origin and a "landing" clone standing in for the GitHub side) in a temp
 * dir. Call the returned cleanup in afterEach.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'unit',
      GIT_AUTHOR_EMAIL: 'unit@test',
      GIT_COMMITTER_NAME: 'unit',
      GIT_COMMITTER_EMAIL: 'unit@test',
    },
  }).trim();
}

/** Give a checkout its own committer identity (see makeRepo). */
function identify(dir: string): void {
  git(dir, ['config', 'user.email', 'unit@test']);
  git(dir, ['config', 'user.name', 'unit']);
}

export interface ScratchRepo {
  root: string;
  repo: string;
  /** Bare origin path (when withOrigin). */
  origin: string;
  /** Second clone standing in for the GitHub side (when withOrigin). */
  landing: string;
  cleanup(): void;
}

export function makeRepo(opts: { withOrigin?: boolean } = {}): ScratchRepo {
  // realpath: on macOS tmpdir() is a symlink into /private — git reports
  // realpaths and path comparisons must match
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'gw-unit-')),
  );
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  // Repo-LOCAL identity, not just the env vars git() passes: code under
  // test creates commits through src/git/exec.ts, which carries no author
  // env of its own, and CI runners have no global git identity.
  identify(repo);
  fs.writeFileSync(path.join(repo, 'app.txt'), 'line1\nline2\nline3\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);

  let origin = '';
  let landing = '';
  if (opts.withOrigin) {
    origin = path.join(root, 'origin.git');
    git(root, ['init', '-q', '-b', 'main', '--bare', 'origin.git']);
    git(repo, ['remote', 'add', 'origin', origin]);
    git(repo, ['push', '-qu', 'origin', 'main']);
    git(root, ['clone', '-q', origin, 'landing']);
    landing = path.join(root, 'landing');
    identify(landing);
  }

  return {
    root,
    repo,
    origin,
    landing,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Create a branch with one commit touching `file`. */
export function addBranch(
  repo: string,
  branch: string,
  file: string,
  content: string,
  from = 'main',
): void {
  git(repo, ['checkout', '-q', '-b', branch, from]);
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', `${branch}: ${file}`]);
  git(repo, ['checkout', '-q', 'main']);
}
