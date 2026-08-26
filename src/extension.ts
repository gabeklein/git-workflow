import * as vscode from 'vscode';
import { registerBranchCommands } from './commands/branchCommands';
import {
  registerIntegrationCommands,
  reportIntegrationResult,
} from './commands/integrationCommands';
import { registerFileExplorerCommands } from './commands/fileExplorerCommands';
import { registerLaneOpsCommands } from './commands/laneOpsCommands';
import { registerWorktreeCommands } from './commands/worktreeCommands';
import { GitContentProvider, GIT_CONTENT_SCHEME } from './git/contentProvider';
import { integrationBaseRef } from './git/integration';
import { createFileBackedLogger } from './log';
import { BranchesTreeProvider } from './views/branchesTree';
import { ChangesTreeProvider } from './views/changesTree';
import { FilesTreeProvider } from './views/filesTree';
import { IntegrationTreeProvider } from './views/integrationTree';
import { WorktreeTreeProvider } from './views/worktreeTree';

export function activate(context: vscode.ExtensionContext): unknown {
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

  const branchesProvider = new BranchesTreeProvider(log);
  context.subscriptions.push(branchesProvider);
  // Keep branch rows in sync with discovered worktrees and git activity
  const syncBranchWorktrees = () => {
    branchesProvider.setWorktrees(treeProvider.getWorktrees());
  };
  context.subscriptions.push(
    treeProvider.onDidChangeWorktrees(syncBranchWorktrees),
    treeProvider.onGitActivity(() => branchesProvider.refreshLocal()),
  );
  syncBranchWorktrees();

  const treeView = vscode.window.createTreeView('worktreeCompare.worktrees', {
    treeDataProvider: treeProvider,
  });
  context.subscriptions.push(treeView);

  const changesProvider = new ChangesTreeProvider(treeProvider);
  context.subscriptions.push(changesProvider);
  const changesView = vscode.window.createTreeView('worktreeCompare.changes', {
    treeDataProvider: changesProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(changesView);

  const filesProvider = new FilesTreeProvider(treeProvider);
  context.subscriptions.push(filesProvider);
  const filesView = vscode.window.createTreeView('worktreeCompare.files', {
    treeDataProvider: filesProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(filesView);

  // Panel descriptions: worktree count / which worktree the Changes show
  const updateSplitViewDescriptions = () => {
    const worktrees = treeProvider.getWorktrees();
    const integrationPath = treeProvider.getIntegration()?.path;
    const listed = worktrees.filter((w) => w.path !== integrationPath).length;
    treeView.description =
      listed > 0 ? `${listed} worktree${listed === 1 ? '' : 's'}` : undefined;
    const selected = treeProvider.getSelected();
    changesView.description = selected
      ? selected.branch + (selected.detached ? ' (detached)' : '')
      : undefined;
    filesView.description = changesView.description;
  };
  updateSplitViewDescriptions();
  context.subscriptions.push(
    treeProvider.onDidChangeWorktrees(updateSplitViewDescriptions),
  );

  const integrationProvider = new IntegrationTreeProvider(treeProvider);
  context.subscriptions.push(integrationProvider);
  const integrationView = vscode.window.createTreeView(
    'worktreeCompare.integration',
    { treeDataProvider: integrationProvider },
  );
  context.subscriptions.push(integrationView);

  // On/off + base + error status live on the panel description
  const updateIntegrationView = () => {
    const integration = treeProvider.getIntegration();
    const wipActive =
      integration &&
      integration.wip.some((l) => integration.lanes.includes(l));
    integrationView.description = !integration
      ? 'off'
      : integration.error?.code === 'conflict'
        ? 'lane conflict'
        : integration.error
          ? 'rebuild failed'
          : `→ ${integrationBaseRef()}${wipActive ? ' · +wip' : ''}`;
    integrationView.message = integration?.error
      ? integration.error.message
      : undefined;
    void vscode.commands.executeCommand(
      'setContext',
      'worktreeCompare.integrationOn',
      Boolean(integration),
    );
    void vscode.commands.executeCommand(
      'setContext',
      'worktreeCompare.integrationMergePaused',
      Boolean(integration?.mergePaused),
    );
    // Absorb is only offered while the checkout actually holds stray edits
    void vscode.commands.executeCommand(
      'setContext',
      'worktreeCompare.integrationDirty',
      integration?.error?.code === 'dirty',
    );
  };
  updateIntegrationView();
  context.subscriptions.push(
    treeProvider.onDidChangeWorktrees(updateIntegrationView),
    treeProvider.onDidChangeTreeData(updateIntegrationView),
  );

  // Lane checkboxes: checked = merged into the integration tree
  context.subscriptions.push(
    integrationView.onDidChangeCheckboxState(async (e) => {
      for (const [item, state] of e.items) {
        if (item.kind === 'integrationBaseDrift') {
          const included = state === vscode.TreeItemCheckboxState.Checked;
          const result = await treeProvider.setBaseDriftIncluded(included);
          reportIntegrationResult(
            result,
            included
              ? `${item.baseName} unpushed work included`
              : `${item.baseName} unpushed work excluded`,
          );
          continue;
        }
        if (item.kind !== 'integrationLane') {
          continue;
        }
        const result =
          state === vscode.TreeItemCheckboxState.Checked
            ? await treeProvider.applyToIntegration(item.branch)
            : await treeProvider.hideFromIntegration(item.branch);
        reportIntegrationResult(
          result,
          state === vscode.TreeItemCheckboxState.Checked
            ? `applied ${item.branch}`
            : `hid ${item.branch}`,
        );
      }
    }),
  );

  const branchesView = vscode.window.createTreeView(
    'worktreeCompare.branches',
    {
      treeDataProvider: branchesProvider,
      showCollapseAll: true,
    },
  );
  context.subscriptions.push(branchesView);
  context.subscriptions.push(
    ...registerWorktreeCommands(treeProvider, log),
    ...registerIntegrationCommands(context, treeProvider, log),
    ...registerBranchCommands(treeProvider, branchesProvider, log),
    ...registerLaneOpsCommands(treeProvider, log),
    ...registerFileExplorerCommands(treeProvider, filesProvider, log),
  );

  // Read-only view-state hooks for the EDH test suite: assertions on what
  // the panels SHOW (badges, selection, integration state), which git-level
  // checks can't reach. Gated — absent in normal sessions.
  if (process.env.GW_TEST_HOOKS === '1') {
    return {
      test: {
        worktrees: () => treeProvider.getWorktrees(),
        selectedPath: () => treeProvider.getSelectedPath(),
        integration: () => treeProvider.getIntegration(),
        baseStatus: (worktreePath: string) =>
          treeProvider.getBaseStatus(worktreePath),
        refreshBaseStatuses: () => treeProvider.refreshBaseStatuses(),
        setBaseDriftIncluded: (included: boolean) =>
          treeProvider.setBaseDriftIncluded(included),
        // RENDERED Integration rows — the exact TreeItems VS Code paints
        // (state hooks alone let "state right, row missing" bugs pass)
        explorerChildren: async (folderRelPath?: string) =>
          (
            await filesProvider.getChildren(
              folderRelPath
                ? ({
                    kind: 'explorerFolder',
                    relPath: folderRelPath,
                  } as Parameters<FilesTreeProvider['getChildren']>[0])
                : undefined,
            )
          ).map((n) => ({
            kind: n.kind,
            label: typeof n.label === 'string' ? n.label : (n.label?.label ?? ''),
            path: n.resourceUri?.fsPath,
          })),
        integrationRows: () =>
          integrationProvider.getChildren().map((item) => ({
            kind: (item as { kind?: string }).kind,
            label:
              typeof item.label === 'string'
                ? item.label
                : (item.label?.label ?? ''),
            description:
              typeof item.description === 'string' ? item.description : '',
            contextValue: item.contextValue,
            checkbox:
              item.checkboxState === undefined
                ? undefined
                : (typeof item.checkboxState === 'object'
                    ? item.checkboxState.state
                    : item.checkboxState) ===
                  vscode.TreeItemCheckboxState.Checked,
          })),
        logFile: () => log.logFile,
      },
    };
  }
  return undefined;
}

export function deactivate(): void {
  // nothing yet
}
