import * as vscode from 'vscode';
import { WorktreeTreeProvider } from './views/worktreeTree';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Worktree Compare');
  context.subscriptions.push(output);
  output.appendLine('Worktree Compare activated');

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
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath;
        if (!target) {
          return;
        }
        const uri = vscode.Uri.file(target);
        await vscode.commands.executeCommand('revealInExplorer', uri);
      },
    ),
  );
}

export function deactivate(): void {
  // nothing yet
}
