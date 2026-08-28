import * as vscode from 'vscode';
import { registerBranchCommands } from './commands/branchCommands';
import {
  registerPreviewCommands,
  reportPreviewResult,
} from './commands/previewCommands';
import { registerFileExplorerCommands } from './commands/fileExplorerCommands';
import { registerLaneOpsCommands } from './commands/laneOpsCommands';
import { registerWorktreeCommands } from './commands/worktreeCommands';
import { GitContentProvider, GIT_CONTENT_SCHEME } from './git/contentProvider';
import { createFileBackedLogger } from './log';
import { BranchesTreeProvider } from './views/branchesTree';
import { LanesTreeProvider } from './views/lanesTree';
import { ChangesTreeProvider } from './views/changesTree';
import { FilesTreeProvider } from './views/filesTree';
import { LaneDragAndDropController } from './views/laneDragAndDrop';
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
  // Keep branch rows in sync with discovered worktrees and git activity.
  // One panel means one Refresh: rediscovering worktrees reloads the branch
  // list too, so the Focus title bar needs a single button rather than one
  // per half.
  const syncBranchWorktrees = () => {
    branchesProvider.setWorktrees(treeProvider.getWorktrees());
    branchesProvider.refreshLocal();
  };
  context.subscriptions.push(
    treeProvider.onDidChangeWorktrees(syncBranchWorktrees),
    treeProvider.onGitActivity(() => branchesProvider.refreshLocal()),
  );
  syncBranchWorktrees();

  // One panel for checkouts AND branches: a worktree is an activity status
  // of a branch, so they belong in one ordered list rather than two views
  // that show the same branch twice.
  const lanesProvider = new LanesTreeProvider(treeProvider, branchesProvider);
  context.subscriptions.push(lanesProvider);
  const treeView = vscode.window.createTreeView('worktreeCompare.lanes', {
    treeDataProvider: lanesProvider,
    showCollapseAll: true,
    // Lanes live under Preview here now; dragging one states which lane
    // wins a conflict, which is only meaningful because merge order is the
    // order YOU set rather than alphabetical (#35).
    dragAndDropController: new LaneDragAndDropController((lane, before) =>
      treeProvider.reorderLane(lane, before),
    ),
  });
  context.subscriptions.push(treeView);

  const filesProvider = new FilesTreeProvider(treeProvider);
  context.subscriptions.push(filesProvider);
  const changesProvider = new ChangesTreeProvider(treeProvider, filesProvider);
  context.subscriptions.push(changesProvider);
  // A fresh id, not the old selector's: VS Code persists size, position and
  // collapse state BY id, so handing `worktreeCompare.focus` to a different
  // panel would make it inherit remembered state that maps to nothing.
  const changesView = vscode.window.createTreeView('worktreeCompare.focused', {
    treeDataProvider: changesProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(changesView);

  // Panel descriptions: worktree count / which worktree the Changes show
  const updateSplitViewDescriptions = () => {
    const worktrees = treeProvider.getWorktrees();
    const previewPath = treeProvider.getPreview()?.path;
    const listed = worktrees.filter((w) => w.path !== previewPath).length;
    treeView.description =
      listed > 0 ? `${listed} worktree${listed === 1 ? '' : 's'}` : undefined;
    const selected = treeProvider.getSelected();
    changesView.description = selected
      ? selected.branch + (selected.detached ? ' (detached)' : '')
      : undefined;
  };
  updateSplitViewDescriptions();
  context.subscriptions.push(
    treeProvider.onDidChangeWorktrees(updateSplitViewDescriptions),
  );

  // Preview is a group in Lanes now, not a panel of its own — a
  // preview is one derived branch built from some of your lanes, not a peer
  // of "your branches". Only the context keys survive.
  const updatePreviewView = () => {
    const preview = treeProvider.getPreview();
    void vscode.commands.executeCommand(
      'setContext',
      'worktreeCompare.previewOn',
      Boolean(preview),
    );
    void vscode.commands.executeCommand(
      'setContext',
      'worktreeCompare.previewMergePaused',
      Boolean(preview?.mergePaused),
    );
    // Absorb is only offered while the checkout actually holds stray edits
    void vscode.commands.executeCommand(
      'setContext',
      'worktreeCompare.previewDirty',
      preview?.error?.code === 'dirty',
    );
  };
  updatePreviewView();
  context.subscriptions.push(
    treeProvider.onDidChangeWorktrees(updatePreviewView),
    treeProvider.onDidChangeTreeData(updatePreviewView),
  );

  // Lane checkboxes: checked = merged into the preview tree
  context.subscriptions.push(
    treeView.onDidChangeCheckboxState(async (e) => {
      for (const [item, state] of e.items) {
        if (item.kind === 'previewBaseDrift') {
          const included = state === vscode.TreeItemCheckboxState.Checked;
          const result = await treeProvider.setBaseDriftIncluded(included);
          reportPreviewResult(
            result,
            included
              ? `${item.baseName} unpushed work included`
              : `${item.baseName} unpushed work excluded`,
          );
          continue;
        }
        if (item.kind !== 'previewLane') continue;
        const result =
          state === vscode.TreeItemCheckboxState.Checked
            ? await treeProvider.applyToPreview(item.branch)
            : await treeProvider.hideFromPreview(item.branch);
        reportPreviewResult(
          result,
          state === vscode.TreeItemCheckboxState.Checked
            ? `applied ${item.branch}`
            : `hid ${item.branch}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    ...registerWorktreeCommands(treeProvider, log),
    ...registerPreviewCommands(context, treeProvider, log),
    ...registerBranchCommands(treeProvider, branchesProvider, log),
    ...registerLaneOpsCommands(treeProvider, log),
    ...registerFileExplorerCommands(treeProvider, filesProvider, log),
  );

  // Read-only view-state hooks for the EDH test suite: assertions on what
  // the panels SHOW (badges, selection, preview state), which git-level
  // checks can't reach. Gated — absent in normal sessions.
  if (process.env.GW_TEST_HOOKS === '1') {
    return {
      test: {
        worktrees: () => treeProvider.getWorktrees(),
        selectedPath: () => treeProvider.getSelectedPath(),
        preview: () => treeProvider.getPreview(),
        baseStatus: (worktreePath: string) =>
          treeProvider.getBaseStatus(worktreePath),
        refreshBaseStatuses: () => treeProvider.refreshBaseStatuses(),
        setBaseDriftIncluded: (included: boolean) =>
          treeProvider.setBaseDriftIncluded(included),
        // RENDERED Preview rows — the exact TreeItems VS Code paints
        // (state hooks alone let "state right, row missing" bugs pass)
        // Through the CHANGES provider, not the files one: routing around
        // the panel would let "section missing from Changes" pass green.
        explorerChildren: async (folderRelPath?: string) => {
          const parent = folderRelPath
            ? ({ kind: 'explorerFolder', relPath: folderRelPath } as never)
            : (await changesProvider.getChildren()).find(
                (n) => n.kind === 'group' && n.group === 'directory',
              );
          const rows = parent
            ? await changesProvider.getChildren(parent)
            : [];
          return rows.map((n) => ({
            kind: n.kind,
            label: typeof n.label === 'string' ? n.label : (n.label?.label ?? ''),
            path: n.resourceUri?.fsPath,
          }));
        },
        /** Top-level Changes rows, in render order. */
        changesRows: async () =>
          (await changesProvider.getChildren()).map((n) => ({
            kind: n.kind,
            label: typeof n.label === 'string' ? n.label : (n.label?.label ?? ''),
          })),
        focusRows: async (
          group?: 'working' | 'local' | 'remote' | 'landed',
        ) => {
          const parent = group
            ? (await lanesProvider.getChildren()).find(
                (n) => n.kind === 'group' && n.group === group,
              )
            : undefined;
          return (await lanesProvider.getChildren(parent)).map((item) => ({
            kind: (item as { kind?: string }).kind,
            group: (item as { group?: string }).group,
            label:
              typeof item.label === 'string'
                ? item.label
                : (item.label?.label ?? ''),
            description:
              typeof item.description === 'string' ? item.description : '',
            contextValue: item.contextValue,
          }));
        },
        // Reads the lanes THROUGH the Lanes panel now: the rows have to
        // arrive via the tree that actually renders them, or a preview that
        // stopped appearing would pass green on its old provider.
        previewRows: async () => {
          const rows = await lanesProvider.getChildren();
          const previewRow = rows.find((n) => n.kind === 'preview');
          const lanes = previewRow
            ? await lanesProvider.getChildren(previewRow)
            : [];
          return lanes.map((item) => ({
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
          }));
        },
        logFile: () => log.logFile,
      },
    };
  }
  return undefined;
}

export function deactivate(): void {
  // nothing yet
}
