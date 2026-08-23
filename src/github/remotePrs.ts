import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { FileChange } from '../git/compare';
import { ensureExcludedFromStatus } from '../git/exclude';
import { git, gitOk } from '../git/exec';
import {
  isGithubPrIntegrationEnabled,
  type PullRequestInfo,
} from './pr';

const execFileAsync = promisify(execFile);

/** Open PR listed for remote review (may not have a local worktree). */
export interface RemotePullRequest extends PullRequestInfo {
  authorLogin?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  /** Local worktree already has this head branch checked out */
  hasLocalWorktree?: boolean;
}

const REMOTE_LIST_FIELDS =
  'number,title,state,url,isDraft,headRefName,baseRefName,author,additions,deletions,changedFiles,mergeable,mergeStateStatus';

interface GhRemotePrRow {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
  author?: { login?: string };
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergeable?: string;
  mergeStateStatus?: string;
}

async function ghJson<T>(
  cwd: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<T | undefined> {
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
    if (!text) {
      return undefined;
    }
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function normalizeRemote(row: GhRemotePrRow): RemotePullRequest | undefined {
  if (
    typeof row.number !== 'number' ||
    !row.url ||
    !row.title ||
    !row.state
  ) {
    return undefined;
  }
  const stateRaw = row.state.toUpperCase();
  let state: PullRequestInfo['state'] = 'open';
  if (stateRaw === 'MERGED') {
    state = 'merged';
  } else if (stateRaw === 'CLOSED') {
    state = 'closed';
  }
  const mergeable = row.mergeable?.toUpperCase();
  return {
    number: row.number,
    title: row.title,
    state,
    isDraft: Boolean(row.isDraft),
    url: row.url,
    headRefName: row.headRefName ?? '',
    baseRefName: row.baseRefName,
    authorLogin: row.author?.login,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changedFiles,
    mergeable:
      mergeable === 'MERGEABLE' ||
      mergeable === 'CONFLICTING' ||
      mergeable === 'UNKNOWN'
        ? mergeable
        : undefined,
    mergeStateStatus: row.mergeStateStatus?.toUpperCase(),
  };
}

export function remotePrLimit(): number {
  const n = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<number>('remotePrLimit', 30);
  return Math.max(1, Math.min(100, n || 30));
}

/** List open PRs for the repo (via gh). Empty if integration off / gh missing. */
export async function listOpenRemotePullRequests(
  repoCwd: string,
): Promise<RemotePullRequest[]> {
  if (!isGithubPrIntegrationEnabled()) {
    return [];
  }
  const rows = await ghJson<GhRemotePrRow[]>(repoCwd, [
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    String(remotePrLimit()),
    '--json',
    REMOTE_LIST_FIELDS,
  ]);
  if (!rows?.length) {
    return [];
  }
  return rows
    .map(normalizeRemote)
    .filter((p): p is RemotePullRequest => Boolean(p));
}

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
    if (await gitOk(repoCwd, ['rev-parse', '--verify', `${candidate}^{commit}`])) {
      return candidate;
    }
  }
  // Last resort: fetch base then use origin/
  try {
    await git(repoCwd, ['fetch', 'origin', name, '--depth', '1']);
  } catch {
    // ignore
  }
  if (await gitOk(repoCwd, ['rev-parse', '--verify', `origin/${name}^{commit}`])) {
    return `origin/${name}`;
  }
  return name;
}

function parseNameStatus(stdout: string): FileChange[] {
  const files: FileChange[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    const statusRaw = parts[0] ?? '';
    const status = statusRaw.charAt(0) || 'M';
    if (parts.length >= 3 && (status === 'R' || status === 'C')) {
      files.push({
        status,
        oldPath: parts[1],
        path: parts[2] ?? parts[1],
      });
    } else if (parts.length >= 2) {
      files.push({ status, path: parts[1] });
    }
  }
  return files;
}

/**
 * Three-dot file list for a PR (base...head) after fetch — no working tree needed.
 */
export async function listRemotePrFiles(
  repoCwd: string,
  pr: RemotePullRequest,
): Promise<{ baseRef: string; headRef: string; files: FileChange[] }> {
  const headRef = await ensurePrHeadFetched(repoCwd, pr.number);
  const baseRef = await resolvePrBaseRef(repoCwd, pr.baseRefName);
  const out = await git(repoCwd, [
    'diff',
    '--name-status',
    '--find-renames',
    `${baseRef}...${headRef}`,
  ]);
  return { baseRef, headRef, files: parseNameStatus(out) };
}

/**
 * Create a linked worktree for a PR under the first watch folder.
 * Does not delete existing folders; throws if destination exists.
 */
export async function createWorktreeForPr(
  repoCwd: string,
  pr: RemotePullRequest,
  destDir: string,
): Promise<string> {
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  try {
    await fs.access(destDir);
    throw new Error(`Path already exists: ${destDir}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Path already')) {
      throw err;
    }
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

