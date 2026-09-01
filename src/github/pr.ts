import * as vscode from 'vscode';

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

type GithubPrMode = 'off' | 'auto';

function getMode(): GithubPrMode {
  const v = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<string>('githubPullRequests', 'auto');
  return v === 'off' ? 'off' : 'auto';
}

/** Whether PR preview is enabled in settings. */
export function isGithubPrIntegrationEnabled(): boolean {
  return getMode() !== 'off';
}

/** True when GitHub reports a real merge conflict (not merely "behind"). */
export function prHasMergeConflicts(pr: PullRequestInfo): boolean {
  if (pr.state !== 'open') return false;
  if (pr.mergeable === 'CONFLICTING') return true;
  // DIRTY = merge conflicts with base (GitHub)
  if (pr.mergeStateStatus === 'DIRTY') return true;
  return false;
}

/** Human-readable PR badge for tree description. */
export function formatPrDescription(pr: PullRequestInfo): string {
  if (pr.state === 'merged') return `#${pr.number} · merged`;
  if (pr.state === 'closed') return `#${pr.number} · closed`;
  if (prHasMergeConflicts(pr)) return `#${pr.number} · conflicts`;
  if (pr.isDraft) return `#${pr.number} · draft`;
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
