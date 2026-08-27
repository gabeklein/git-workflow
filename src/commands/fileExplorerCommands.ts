import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  ExplorerFileItem,
  ExplorerFolderItem,
  FilesTreeProvider,
} from '../views/filesTree';
import type { WorktreeTreeProvider } from '../views/worktreeTree';

/** Commands for the Directory section of the Changes panel. */
export function registerFileExplorerCommands(
  treeProvider: WorktreeTreeProvider,
  filesProvider: FilesTreeProvider,
  log: { appendLine(value: string): void },
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      'worktreeCompare.copyPath',
      async (item?: { resourceUri?: vscode.Uri; kind?: string }) => {
        // The section row carries no resourceUri — it stands for the
        // checkout itself, so fall back to the focused worktree's root.
        const target =
          item?.resourceUri?.fsPath ?? treeProvider.getSelectedPath();
        if (!target) {
          return;
        }
        await vscode.env.clipboard.writeText(target);
        void vscode.window.setStatusBarMessage(
          `Git Workflow: copied ${path.basename(target)} path`,
          2000,
        );
        log.appendLine(`Copied path: ${target}`);
      },
    ),
    vscode.commands.registerCommand('worktreeCompare.refreshFiles', () =>
      filesProvider.refresh(),
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.newFileInWorktree',
      // Folder context menus pass the folder; the Directory group row passes a
      // GroupItem, which is not a folder and correctly means "at the root";
      // tests/automation may pass the relative path directly.
      async (item?: ExplorerFolderItem, nameArg?: unknown) => {
        const selected = treeProvider.getSelectedPath();
        if (!selected) {
          return;
        }
        const baseDir = item?.kind === 'explorerFolder' ? item.relPath : '';
        const rel =
          typeof nameArg === 'string' && nameArg.trim()
            ? nameArg.trim()
            : await vscode.window.showInputBox({
                prompt: `New file in ${path.basename(selected)}${baseDir ? `/${baseDir}` : ''}`,
                placeHolder: 'path/to/file.ts',
                ignoreFocusOut: true,
                validateInput: (v) =>
                  v.trim() ? undefined : 'File path is required',
              });
        if (!rel?.trim()) {
          return;
        }
        const target = path.join(selected, baseDir, rel.trim());
        // Never write outside the worktree, even via ../ in the input
        if (!path.resolve(target).startsWith(path.resolve(selected) + path.sep)) {
          void vscode.window.showErrorMessage(
            'Git Workflow: the new file must live inside the worktree',
          );
          return;
        }
        try {
          const uri = vscode.Uri.file(target);
          try {
            await vscode.workspace.fs.stat(uri);
            void vscode.window.showErrorMessage(
              `Git Workflow: ${rel.trim()} already exists`,
            );
            return;
          } catch {
            // good — does not exist yet
          }
          await vscode.workspace.fs.writeFile(uri, new Uint8Array());
          filesProvider.refresh();
          await vscode.window.showTextDocument(uri, { preview: false });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`New file failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not create file — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.deleteWorktreeEntry',
      async (item?: ExplorerFileItem | ExplorerFolderItem) => {
        const uri = item?.resourceUri;
        if (!uri) {
          return;
        }
        const isFolder = item.kind === 'explorerFolder';
        const confirm = await vscode.window.showWarningMessage(
          `Delete ${isFolder ? 'folder' : 'file'} “${path.basename(uri.fsPath)}”${isFolder ? ' and its contents' : ''}?`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') {
          return;
        }
        try {
          await vscode.workspace.fs.delete(uri, {
            recursive: isFolder,
            useTrash: true,
          });
          filesProvider.refresh();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not delete — ${message}`,
          );
        }
      },
    ),
  ];
}
