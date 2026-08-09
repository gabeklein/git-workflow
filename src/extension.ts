import * as vscode from 'vscode';
import {
  openCommitFileDiff,
  openStagedDiff,
  openUnstagedDiff,
  openWorkingTreeDiff,
} from './compare/openDiff';
import { pickBaseRef } from './compare/pickBaseRef';
import { pickWorktree } from './compare/pickWorktree';
import { GitContentProvider, GIT_CONTENT_SCHEME } from './git/contentProvider';
import { stagePaths, unstagePaths } from './git/stage';
import { createFileBackedLogger } from './log';
import {
  CommitItem,
  FileItem,
  WorktreeTreeProvider,
} from './views/worktreeTree';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Git Workflow');
  context.subscriptions.push(output);
  const log = createFileBackedLogger(context, output);
  context.subscriptions.push(log);
  log.appendLine('Git Workflow activated');

  const contentProvider = new GitContentProvider();
  context.subscriptions.push(
    contentProvider,
    vscode.workspace.registerTextDocumentContentProvider(
      GIT_CONTENT_SCHEME,
      contentProvider,
    ),
  );

  const treeProvider = new WorktreeTreeProvider(log, context);
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
      'worktreeCompare.focusWorktree',
      async (pathOrItem?: string | { worktreePath?: string }) => {
        const path =
          typeof pathOrItem === 'string'
            ? pathOrItem
            : pathOrItem?.worktreePath;
        if (!path) {
          return;
        }
        await treeProvider.setSelectedPath(path);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.selectWorktree',
      async () => {
        const picked = await pickWorktree(
          treeProvider.getWorktrees(),
          treeProvider.getSelectedPath(),
        );
        if (!picked) {
          return;
        }
        await treeProvider.setSelectedPath(picked.path);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.openWorktree',
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath ?? treeProvider.getSelectedPath();
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
        const worktreePath =
          item?.worktreePath ?? treeProvider.getSelectedPath();
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
          log.appendLine(`Change base ref failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not change base — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.copyCommitSha',
      async (item?: CommitItem) => {
        const sha = item?.commit.hash;
        if (!sha) {
          return;
        }
        await vscode.env.clipboard.writeText(sha);
        void vscode.window.setStatusBarMessage(
          `Git Workflow: copied ${item.commit.shortHash}`,
          2000,
        );
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
          if (item.statusSide === 'staged') {
            await openStagedDiff(item.worktreePath, item.file);
            return;
          }
          await openUnstagedDiff(item.worktreePath, item.file);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Open diff failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not open diff — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.stageFile',
      async (item?: FileItem) => {
        if (!item?.file.path) {
          return;
        }
        try {
          const paths = [item.file.path];
          if (item.file.oldPath) {
            paths.push(item.file.oldPath);
          }
          await stagePaths(item.worktreePath, paths);
          treeProvider.refreshCompare(item.worktreePath);
          log.appendLine(`Staged ${item.file.path}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Stage failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not stage — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.unstageFile',
      async (item?: FileItem) => {
        if (!item?.file.path) {
          return;
        }
        try {
          const paths = [item.file.path];
          if (item.file.oldPath) {
            paths.push(item.file.oldPath);
          }
          await unstagePaths(item.worktreePath, paths);
          treeProvider.refreshCompare(item.worktreePath);
          log.appendLine(`Unstaged ${item.file.path}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Unstage failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not unstage — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand('worktreeCompare.openLogFile', async () => {
      const uri = vscode.Uri.file(log.logFile);
      await vscode.window.showTextDocument(uri);
    }),
  );
}

export function deactivate(): void {
  // nothing yet
}
