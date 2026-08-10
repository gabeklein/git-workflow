import * as vscode from 'vscode';

/** Custom scheme so FileDecoration can tint / badge worktree rows. */
export const WORKTREE_URI_SCHEME = 'git-workflow-wt';

export function worktreeResourceUri(fsPath: string): vscode.Uri {
  // Normalize to a stable path form for Uri equality
  const asFile = vscode.Uri.file(fsPath);
  return vscode.Uri.from({
    scheme: WORKTREE_URI_SCHEME,
    path: asFile.path,
  });
}

export function fsPathFromWorktreeUri(uri: vscode.Uri): string {
  return vscode.Uri.file(uri.path).fsPath;
}

/**
 * Emphasize the selected worktree row (TreeItems cannot be bold).
 * Applies a blue label tint via FileDecoration (no badge).
 */
export class WorktreeSelectionDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private selectedPath: string | undefined;
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.window.registerFileDecorationProvider(this);
  }

  setSelectedPath(fsPath: string | undefined): void {
    if (this.selectedPath === fsPath) {
      return;
    }
    const prev = this.selectedPath;
    this.selectedPath = fsPath;
    const uris: vscode.Uri[] = [];
    if (prev) {
      uris.push(worktreeResourceUri(prev));
    }
    if (fsPath) {
      uris.push(worktreeResourceUri(fsPath));
    }
    this._onDidChangeFileDecorations.fire(uris.length > 0 ? uris : undefined);
  }

  provideFileDecoration(
    uri: vscode.Uri,
  ): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== WORKTREE_URI_SCHEME || !this.selectedPath) {
      return undefined;
    }
    const rowPath = fsPathFromWorktreeUri(uri);
    if (rowPath !== this.selectedPath) {
      return undefined;
    }
    return {
      tooltip: 'Selected worktree',
      color: new vscode.ThemeColor('charts.blue'),
    };
  }

  dispose(): void {
    this.disposable.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}
