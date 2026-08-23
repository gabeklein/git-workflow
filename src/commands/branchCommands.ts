import * as vscode from 'vscode';
/** Command registrations — split by domain; wired from extension.ts. */
import { openRemotePrFileDiff } from '../compare/openDiff';
import { createWorktreeForBranch, suggestWorktreePath } from '../git/branches';
import { createWorktreeForPr } from '../github/remotePrs';
import type { BranchItem, RemotePrFileItem } from '../views/nodes';
import type { BranchesTreeProvider } from '../views/branchesTree';
import type { WorktreeTreeProvider } from '../views/worktreeTree';

export function registerBranchCommands(
  treeProvider: WorktreeTreeProvider,
  branchesProvider: BranchesTreeProvider,
  log: { appendLine(value: string): void },
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      'worktreeCompare.refreshBranches',
      async () => {
        branchesProvider.setWorktrees(treeProvider.getWorktrees());
        branchesProvider.refresh();
        void vscode.window.setStatusBarMessage(
          'Git Workflow: refreshed branches',
          2000,
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.openRemotePrFile',
      async (item?: RemotePrFileItem) => {
        if (!item) {
          return;
        }
        try {
          await openRemotePrFileDiff(
            item.repoCwd,
            item.baseRef,
            item.headRef,
            item.file,
            `PR #${item.pr.number}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Open remote PR file failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not open PR file — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.createWorktreeFromBranch',
      async (item?: BranchItem) => {
        if (!item?.branch) {
          return;
        }
        const repoCwd = item.repoCwd;
        if (item.worktreePath) {
          void vscode.window.showInformationMessage(
            `Git Workflow: ${item.branch} already has a worktree`,
          );
          return;
        }

        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? repoCwd;
        const suggested = suggestWorktreePath(workspaceRoot, item.branch);
        const dest = await vscode.window.showInputBox({
          prompt: `Create worktree for ${item.branch}`,
          value: suggested,
          ignoreFocusOut: true,
          validateInput: (v) =>
            v.trim() ? undefined : 'Destination path is required',
        });
        if (!dest?.trim()) {
          return;
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Git Workflow: creating worktree for ${item.branch}…`,
            },
            async () => {
              // PR head with no local/remote ref (fork) → fetch via PR
              const created =
                !item.hasLocalRef && !item.hasRemote && item.pr
                  ? await createWorktreeForPr(repoCwd, item.pr, dest.trim())
                  : await createWorktreeForBranch(
                      repoCwd,
                      item.branch,
                      item.hasLocalRef,
                      dest.trim(),
                    );
              log.appendLine(
                `Created worktree for ${item.branch} at ${created}`,
              );
              treeProvider.refresh();
              branchesProvider.refresh();
              await treeProvider.setSelectedPath(created);
              void vscode.window.showInformationMessage(
                `Git Workflow: worktree ready at ${created}`,
              );
            },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Create worktree failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not create worktree — ${message}`,
          );
        }
      },
    ),
  ];
}
