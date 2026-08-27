import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { git } from '../git/exec';

const execFileAsync = promisify(execFile);

/** Normalized PR association for a worktree branch. */
export interface PullRequestInfo {
  number: number;
  title: string;
  /** open | closed | merged */
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  url: string;
  headRefName: string;
  /** GitHub mergeable: MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** GitHub mergeStateStatus: CLEAN | DIRTY | BLOCKED | BEHIND | DRAFT | … */
  mergeStateStatus?: string;
  /** PR base branch name (e.g. staging) when known */
  baseRefName?: string;
}

export type GithubPrMode = 'off' | 'auto';

const PR_JSON_FIELDS =
  'number,title,state,url,isDraft,headRefName,mergeable,mergeStateStatus,baseRefName';

let ghAvailable: boolean | undefined;
let ghCheckInFlight: Promise<boolean> | undefined;

function getMode(): GithubPrMode {
  const v = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<string>('githubPullRequests', 'auto');
  return v === 'off' ? 'off' : 'auto';
}

/** Whether PR integration is enabled in settings. */
export function isGithubPrIntegrationEnabled(): boolean {
  return getMode() !== 'off';
}

async function isGhAvailable(): Promise<boolean> {
  if (ghAvailable !== undefined) {
    return ghAvailable;
  }
  if (ghCheckInFlight) {
    return ghCheckInFlight;
  }
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

/** Reset cached gh availability (e.g. after config change / PATH fix). */
export function resetGithubPrClient(): void {
  ghAvailable = undefined;
  ghCheckInFlight = undefined;
}

async function ghJson<T>(
  cwd: string,
  args: string[],
  timeoutMs = 12_000,
): Promise<T | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
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

interface GhPrRow {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  isDraft?: boolean;
  headRefName?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  baseRefName?: string;
}

function normalizeMergeable(
  raw: string | undefined,
): PullRequestInfo['mergeable'] | undefined {
  if (!raw) {
    return undefined;
  }
  const u = raw.toUpperCase();
  if (u === 'MERGEABLE' || u === 'CONFLICTING' || u === 'UNKNOWN') {
    return u;
  }
  return undefined;
}

function normalizePr(row: GhPrRow): PullRequestInfo | undefined {
  if (
    typeof row.number !== 'number' ||
    !row.url ||
    !row.title ||
    !row.state
  ) {
    return undefined;
  }
  const stateRaw = row.state.toUpperCase();
  let state: PullRequestInfo['state'];
  if (stateRaw === 'MERGED') {
    state = 'merged';
  } else if (stateRaw === 'CLOSED') {
    state = 'closed';
  } else {
    state = 'open';
  }
  return {
    number: row.number,
    title: row.title,
    state,
    isDraft: Boolean(row.isDraft),
    url: row.url,
    headRefName: row.headRefName ?? '',
    mergeable: normalizeMergeable(row.mergeable),
    mergeStateStatus: row.mergeStateStatus?.toUpperCase(),
    baseRefName: row.baseRefName,
  };
}

/**
 * Prefer open (incl. draft) PRs for a head branch; fall back to most recent closed/merged.
 */
export async function findPullRequestForBranch(
  worktreePath: string,
  branch: string,
  detached: boolean,
): Promise<PullRequestInfo | undefined> {
  if (!isGithubPrIntegrationEnabled() || detached || !branch || branch === 'HEAD') {
    return undefined;
  }
  if (!(await isGhAvailable())) {
    return undefined;
  }

  // Open first (includes drafts when not filtered)
  const openList = await ghJson<GhPrRow[]>(worktreePath, [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--limit',
    '5',
    '--json',
    PR_JSON_FIELDS,
  ]);
  if (openList?.length) {
    // Prefer exact head match, then first
    const exact =
      openList.find((r) => r.headRefName === branch) ?? openList[0];
    const pr = normalizePr(exact);
    if (pr) {
      // list sometimes omits mergeable — view for conflict detail on open PRs
      return enrichOpenPr(worktreePath, pr);
    }
  }

  // Closed / merged (useful so we still show status on landed branches)
  const allList = await ghJson<GhPrRow[]>(worktreePath, [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--limit',
    '5',
    '--json',
    PR_JSON_FIELDS,
  ]);
  if (!allList?.length) {
    return undefined;
  }
  const exact = allList.find((r) => r.headRefName === branch) ?? allList[0];
  return normalizePr(exact);
}

/** Ensure mergeable is populated for open PRs (list can be sparse). */
async function enrichOpenPr(
  worktreePath: string,
  pr: PullRequestInfo,
): Promise<PullRequestInfo> {
  if (pr.state !== 'open' || pr.mergeable === 'CONFLICTING') {
    return pr;
  }
  if (pr.mergeable === 'MERGEABLE' || pr.mergeable === 'UNKNOWN') {
    // Still refresh DIRTY via mergeStateStatus when missing
    if (pr.mergeStateStatus) {
      return pr;
    }
  }
  const detail = await ghJson<GhPrRow>(worktreePath, [
    'pr',
    'view',
    String(pr.number),
    '--json',
    PR_JSON_FIELDS,
  ]);
  if (!detail) {
    return pr;
  }
  return normalizePr(detail) ?? pr;
}

/** True when GitHub reports a real merge conflict (not merely "behind"). */
export function prHasMergeConflicts(pr: PullRequestInfo): boolean {
  if (pr.state !== 'open') {
    return false;
  }
  if (pr.mergeable === 'CONFLICTING') {
    return true;
  }
  // DIRTY = merge conflicts with base (GitHub)
  if (pr.mergeStateStatus === 'DIRTY') {
    return true;
  }
  return false;
}

/** Human-readable PR badge for tree description. */
export function formatPrDescription(pr: PullRequestInfo): string {
  if (pr.state === 'merged') {
    return `#${pr.number} · merged`;
  }
  if (pr.state === 'closed') {
    return `#${pr.number} · closed`;
  }
  if (prHasMergeConflicts(pr)) {
    return `#${pr.number} · conflicts`;
  }
  if (pr.isDraft) {
    return `#${pr.number} · draft`;
  }
  return `#${pr.number} · open`;
}

/** Status icon + theme color for open / draft / merged / closed / conflicts. */
export function prThemeIcon(pr: PullRequestInfo): vscode.ThemeIcon {
  if (pr.state === 'merged') {
    return new vscode.ThemeIcon(
      'git-merge',
      new vscode.ThemeColor('charts.purple'),
    );
  }
  if (pr.state === 'closed') {
    return new vscode.ThemeIcon(
      'git-pull-request-closed',
      new vscode.ThemeColor('charts.red'),
    );
  }
  if (prHasMergeConflicts(pr)) {
    // charts.red, not list.errorForeground: the latter is whatever the
    // theme makes of it and commonly renders orange, which reads as a
    // warning next to genuinely orange states like a paused merge.
    return new vscode.ThemeIcon(
      'git-pull-request',
      new vscode.ThemeColor('charts.red'),
    );
  }
  if (pr.isDraft) {
    return new vscode.ThemeIcon(
      'git-pull-request-draft',
      new vscode.ThemeColor('descriptionForeground'),
    );
  }
  // open
  return new vscode.ThemeIcon(
    'git-pull-request',
    new vscode.ThemeColor('charts.green'),
  );
}

/**
 * Best-effort github.com owner/repo from origin URL (for tooltips / future API use).
 */
export async function resolveGithubRepoSlug(
  worktreePath: string,
): Promise<string | undefined> {
  try {
    const url = (await git(worktreePath, ['remote', 'get-url', 'origin'])).trim();
    return parseGithubSlug(url);
  } catch {
    return undefined;
  }
}

export function parseGithubSlug(remoteUrl: string): string | undefined {
  // git@github.com:owner/repo.git  |  https://github.com/owner/repo.git
  const ssh = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (ssh) {
    return `${ssh[1]}/${ssh[2]}`;
  }
  return undefined;
}

/** Map key for PR cache (path + branch). */
export function prCacheKey(worktreePath: string, branch: string): string {
  return `${worktreePath}\0${branch}`;
}
