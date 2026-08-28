import * as vscode from 'vscode';
import { showFileAtRef } from './compare';

export const GIT_CONTENT_SCHEME = 'worktree-compare';

/**
 * URI shape:
 *   worktree-compare:/relative/path?cwd=<abs>&ref=<ref>
 *
 * Used as the left (read-only) side of diffs. Working tree side stays a real file URI.
 */
export function toGitContentUri(
  worktreePath: string,
  ref: string,
  relativePath: string,
): vscode.Uri {
  const path = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return vscode.Uri.from({
    scheme: GIT_CONTENT_SCHEME,
    path,
    query: new URLSearchParams({ cwd: worktreePath, ref }).toString(),
  });
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const cwd = params.get('cwd');
    const ref = params.get('ref');
    if (!cwd || !ref) return '';
    // uri.path is absolute-form "/foo/bar.ts"
    const relativePath = uri.path.replace(/^\//, '');
    return showFileAtRef(cwd, ref, relativePath);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
