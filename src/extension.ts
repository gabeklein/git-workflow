import * as vscode from 'vscode';
import {
  openCommitFileDiff,
  openWorkingTreeDiff,
} from './compare/openDiff';
import { pickBaseRef } from './compare/pickBaseRef';
import { GitContentProvider, GIT_CONTENT_SCHEME } from './git/contentProvider';
import { FileItem, WorktreeItem, WorktreeTreeProvider } from './views/worktreeTree';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Git Workflow');
  context.subscriptions.push(output);
  output.appendLine('Git Workflow activated');

  const contentProvider = new GitContentProvider();
  context.subscriptions.push(
    contentProvider,
    vscode.workspace.registerTextDocumentContentProvider(
      GIT_CONTENT_SCHEME,
      contentProvider,
    ),
  );

  const treeProvider = new WorktreeTreeProvider(output);
  context.subscriptions.push(treeProvider);

  const treeView = vscode.window.createTreeView('worktreeCompare.worktrees', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('worktreeCompare.refresh', () => {
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand(
      'worktreeCompare.openWorktree',
      async (item?: WorktreeItem) => {
        const target = item?.worktreePath;
        if (!target) {
          return;
        }
        await vscode.commands.executeCommand(
          'revealInExplorer',
          vscode.Uri.file(target),
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.changeBaseRef',
      async (item?: { worktreePath?: string; baseRef?: string }) => {
        const worktreePath = item?.worktreePath;
        if (!worktreePath) {
          return;
        }
        const current =
          item?.baseRef ?? treeProvider.getBaseRef(worktreePath);
        try {
          const picked = await pickBaseRef(worktreePath, current);
          if (!picked) {
            return;
          }
          await treeProvider.setBaseRef(worktreePath, picked);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output.appendLine(`Change base ref failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not change base — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.openFileDiff',
      async (item?: FileItem) => {
        if (!item) {
          return;
        }
        try {
          if (item.diffKind === 'commit' && item.commitHash) {
            await openCommitFileDiff(
              item.worktreePath,
              item.commitHash,
              item.file,
            );
            return;
          }
          if (item.diffKind === 'vsBase') {
            await openWorkingTreeDiff(
              item.worktreePath,
              item.baseRef,
              item.file,
              'Working Tree',
            );
            return;
          }
          // Staged / unstaged: editable vs HEAD
          await openWorkingTreeDiff(
            item.worktreePath,
            'HEAD',
            item.file,
            'Working Tree',
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          output.appendLine(`Open diff failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not open diff — ${message}`,
          );
        }
      },
    ),
  );
}

export function deactivate(): void {
  // nothing yet
}
