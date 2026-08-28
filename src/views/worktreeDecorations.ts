import * as vscode from 'vscode';

/** Custom scheme so FileDecoration can tint / badge worktree rows. */
const WORKTREE_URI_SCHEME = 'git-workflow-wt';

/**
 * File/folder rows in the tree. Same path as the checkout so the icon theme
 * still keys off the extension, but not `file:` — git / GitLens must not
 * open a repository (and a recursive watcher) for every listed path.
 */
const WORKTREE_FILE_URI_SCHEME = 'git-workflow-file';

/**
 * Branch rows. A lane is a branch REF — a worktree is not required to merge
 * one — so a branch with no checkout can still be in the preview and needs
 * somewhere to hang its badge.
 */
const BRANCH_URI_SCHEME = 'git-workflow-branch';

export function branchResourceUri(branch: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BRANCH_URI_SCHEME, path: `/${branch}` });
}

function branchFromUri(uri: vscode.Uri): string {
  return uri.path.replace(/^\//, '');
}

export function worktreeResourceUri(fsPath: string): vscode.Uri {
  // Normalize to a stable path form for Uri equality
  const asFile = vscode.Uri.file(fsPath);
  return vscode.Uri.from({
    scheme: WORKTREE_URI_SCHEME,
    path: asFile.path,
  });
}

export function worktreeFileUri(fsPath: string): vscode.Uri {
  const asFile = vscode.Uri.file(fsPath);
  return vscode.Uri.from({
    scheme: WORKTREE_FILE_URI_SCHEME,
    path: asFile.path,
  });
}

function fsPathFromWorktreeUri(uri: vscode.Uri): string {
  return vscode.Uri.file(uri.path).fsPath;
}

/**
 * Row decorations for checkouts: a blue tint on the selected one, and a
 * badge on those merged into the integration preview.
 *
 * The badge is spent on lane membership rather than selection because
 * selection is already obvious — the list paints it — while "is this in the
 * preview?" otherwise costs a word of description on every row.
 */
export class WorktreeRowDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private selectedPath: string | undefined;
  private appliedPaths = new Set<string>();
  private appliedBranches = new Set<string>();
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.window.registerFileDecorationProvider(this);
  }

  setSelectedPath(fsPath: string | undefined): void {
    if (this.selectedPath === fsPath) return;
    const prev = this.selectedPath;
    this.selectedPath = fsPath;
    const uris: vscode.Uri[] = [];
    if (prev) uris.push(worktreeResourceUri(prev));
    if (fsPath) uris.push(worktreeResourceUri(fsPath));
    this._onDidChangeFileDecorations.fire(uris.length > 0 ? uris : undefined);
  }

  /**
   * What is currently merged into the preview: checkout paths for rows that
   * have one, branch names for rows that do not. Both kinds of row wear the
   * same badge, because membership is a property of the branch either way.
   */
  setApplied(applied: {
    paths: Iterable<string>;
    branches: Iterable<string>;
  }): void {
    const paths = new Set(applied.paths);
    const branches = new Set(applied.branches);
    const same = (a: Set<string>, b: Set<string>) =>
      a.size === b.size && [...a].every((x) => b.has(x));
    if (same(paths, this.appliedPaths) && same(branches, this.appliedBranches))
      return;
    const changed = [
      ...[...new Set([...paths, ...this.appliedPaths])].map((p) =>
        worktreeResourceUri(p),
      ),
      ...[...new Set([...branches, ...this.appliedBranches])].map((b) =>
        branchResourceUri(b),
      ),
    ];
    this.appliedPaths = paths;
    this.appliedBranches = branches;
    this._onDidChangeFileDecorations.fire(changed);
  }

  provideFileDecoration(
    uri: vscode.Uri,
  ): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme === BRANCH_URI_SCHEME) {
      return this.appliedBranches.has(branchFromUri(uri))
        ? { badge: '●', tooltip: 'In the integration preview' }
        : undefined;
    }
    if (uri.scheme !== WORKTREE_URI_SCHEME) return undefined;
    const rowPath = fsPathFromWorktreeUri(uri);
    const selected = rowPath === this.selectedPath;
    const applied = this.appliedPaths.has(rowPath);
    if (!selected && !applied) return undefined;
    return {
      badge: applied ? '●' : undefined,
      tooltip: [
        applied ? 'In the integration preview' : undefined,
        selected ? 'Selected worktree' : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
      color: selected ? new vscode.ThemeColor('charts.blue') : undefined,
    };
  }

  dispose(): void {
    this.disposable.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}
