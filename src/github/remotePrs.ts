import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ensureExcludedFromStatus } from '../git/exclude';
import { git, gitOk } from '../git/exec';
import type { RemotePullRequest } from './prIndex';

export type { RemotePullRequest };

/** Tracking ref for a fetched PR head: refs/remotes/pr/<n> */
export function prRemoteRef(prNumber: number): string {
  return `refs/remotes/pr/${prNumber}`;
}

/**
 * Fetch PR head into refs/remotes/pr/<n> (object download only — no worktree).
 * Returns the ref name on success.
 */
export async function ensurePrHeadFetched(
  repoCwd: string,
  prNumber: number,
): Promise<string> {
  const ref = prRemoteRef(prNumber);
  // Force update so re-reviews see latest head
  await git(repoCwd, [
    'fetch',
    'origin',
    `pull/${prNumber}/head:${ref}`,
    '--force',
  ]);
  return ref;
}

/** Prefer origin/<base> when present. */
export async function resolvePrBaseRef(
  repoCwd: string,
  baseRefName: string | undefined,
): Promise<string> {
  const name = (baseRefName || 'main').trim();
  for (const candidate of [`origin/${name}`, name]) {
    if (await gitOk(repoCwd, ['rev-parse', '--verify', `${candidate}^{commit}`]))
      return candidate;
  }
  // Last resort: fetch base then use origin/
  try {
    await git(repoCwd, ['fetch', 'origin', name, '--depth', '1']);
  } catch {
    // ignore
  }
  if (await gitOk(repoCwd, ['rev-parse', '--verify', `origin/${name}^{commit}`]))
    return `origin/${name}`;
  return name;
}

/**
 * Create a linked worktree for a PR under the first watch folder.
 * Does not delete existing folders; throws if destination exists.
 */
export async function createWorktreeForPr(
  repoCwd: string,
  pr: Pick<RemotePullRequest, 'number' | 'headRefName'>,
  destDir: string,
): Promise<string> {
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  try {
    await fs.access(destDir);
    throw new Error(`Path already exists: ${destDir}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Path already'))
      throw err;
    // ENOENT — free to create
  }

  // Repo-local ignore before creation, so status never flashes dirty
  await ensureExcludedFromStatus(destDir).catch(() => undefined);
  const headRef = await ensurePrHeadFetched(repoCwd, pr.number);
  const branch = pr.headRefName || `pr-${pr.number}`;

  // Prefer existing local branch if free; else create branch at PR head
  const branchExists = await gitOk(repoCwd, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);

  if (branchExists) {
    // May fail if already checked out elsewhere
    await git(repoCwd, ['worktree', 'add', destDir, branch]);
  } else {
    await git(repoCwd, [
      'worktree',
      'add',
      '-b',
      branch,
      destDir,
      headRef,
    ]);
  }
  return destDir;
}

