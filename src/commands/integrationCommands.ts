import * as path from 'node:path';
import * as vscode from 'vscode';
/** Command registrations — split by domain; wired from extension.ts. */
import { pickBaseRef } from '../compare/pickBaseRef';
import {
  createIntegrationWorktree,
  deleteIntegrationBranch,
  integrationBaseRef,
  integrationBranch,
  switchAwayFromIntegration,
  switchToIntegrationBranch,
  type RebuildResult,
} from '../git/integration';
import { suggestWorktreePath } from '../git/branches';
import { isWorktreeDirty } from '../git/plumbing';
import { removeWorktree } from '../git/worktreeAdmin';
import type { WorktreeTreeProvider } from '../views/worktreeTree';

/** Branch the root checkout was on before enabling integration on it. */
const INTEGRATION_RETURN_KEY = 'worktreeCompare.integrationReturnBranch';

export function registerIntegrationCommands(
  context: vscode.ExtensionContext,
  treeProvider: WorktreeTreeProvider,
  log: { appendLine(value: string): void },
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      'worktreeCompare.enableIntegration',
      async () => {
        if (treeProvider.getIntegration()) {
          void vscode.window.showInformationMessage(
            'Git Workflow: integration mode is already on',
          );
          return;
        }
        const repoCwd = treeProvider.getRepoCwd();
        if (!repoCwd) {
          void vscode.window.showErrorMessage(
            'Git Workflow: no git repository found in this workspace',
          );
          return;
        }
        const branch = integrationBranch();
        const baseRef = integrationBaseRef();
        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? repoCwd;

        const mode = await vscode.window.showQuickPick(
          [
            {
              label: 'Use this checkout',
              description: `switch ${path.basename(workspaceRoot)} to ${branch}`,
              detail:
                'The workspace root becomes the integration surface — checked lanes appear right here.',
              id: 'main' as const,
            },
            {
              label: 'Create a separate worktree…',
              description: 'keep this checkout on its branch',
              detail: `A new worktree on ${branch} holds the combined lanes.`,
              id: 'worktree' as const,
            },
          ],
          { placeHolder: 'Enable integration mode' },
        );
        if (!mode) {
          return;
        }

        try {
          if (mode.id === 'main') {
            if (await isWorktreeDirty(workspaceRoot)) {
              void vscode.window.showErrorMessage(
                `Git Workflow: this checkout has uncommitted changes — commit or stash before switching to ${branch}`,
              );
              return;
            }
            const previous = await switchToIntegrationBranch(
              workspaceRoot,
              baseRef,
            );
            await context.workspaceState.update(
              INTEGRATION_RETURN_KEY,
              previous,
            );
            log.appendLine(
              `Integration mode on: ${workspaceRoot} switched ${previous ?? '(detached)'} → ${branch}`,
            );
          } else {
            const suggested = suggestWorktreePath(workspaceRoot, 'working');
            const dest = await vscode.window.showInputBox({
              prompt: `Create a worktree on ${branch}`,
              value: suggested,
              ignoreFocusOut: true,
              validateInput: (v) =>
                v.trim() ? undefined : 'Destination path is required',
            });
            if (!dest?.trim()) {
              return;
            }
            await createIntegrationWorktree(repoCwd, dest.trim(), baseRef);
            log.appendLine(`Integration worktree created at ${dest.trim()}`);
          }
          treeProvider.refresh();
          void vscode.window.showInformationMessage(
            'Git Workflow: integration mode on — add worktrees via their context menu, then check lanes under Integration',
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Enable integration failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not enable integration — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.disableIntegration',
      async () => {
        const integration = treeProvider.getIntegration();
        if (!integration) {
          return;
        }
        const wt = treeProvider.getWorktree(integration.path);
        const onMainCheckout = Boolean(
          wt?.isRootCheckout || wt?.isMainWorktree,
        );
        const confirm = await vscode.window.showWarningMessage(
          [
            'Disable integration mode?',
            '',
            onMainCheckout
              ? `This switches ${integration.path} off ${integration.branch} (back to your previous branch), discarding derived state.`
              : `This removes the ${integration.branch} worktree at:\n${integration.path}`,
            '',
            `The ${integration.branch} branch is deleted (it is derived state). The lane list is kept — enabling again restores the same lanes.`,
          ].join('\n'),
          { modal: true },
          'Disable',
        );
        if (confirm !== 'Disable') {
          return;
        }
        try {
          if (onMainCheckout) {
            const baseRef = integrationBaseRef();
            const returned = await switchAwayFromIntegration(
              integration.path,
              context.workspaceState.get<string>(INTEGRATION_RETURN_KEY),
              baseRef,
            );
            await context.workspaceState.update(
              INTEGRATION_RETURN_KEY,
              undefined,
            );
            log.appendLine(
              `Integration mode off: ${integration.path} switched back to ${returned}`,
            );
          } else {
            // Integration tree contents are always derived — force is safe
            const result = await removeWorktree(integration.path, {
              force: true,
            });
            if (!result.ok) {
              throw new Error(result.message);
            }
            log.appendLine(
              `Integration worktree removed: ${integration.path}`,
            );
          }
          // Branch is derived state — delete so nothing straggles.
          // (Best-effort; cwd must be a surviving checkout.)
          const repoCwd = treeProvider.getRepoCwd();
          const cwd = onMainCheckout
            ? integration.path
            : repoCwd !== integration.path
              ? repoCwd
              : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (cwd && (await deleteIntegrationBranch(cwd))) {
            log.appendLine(`Integration branch deleted: ${integration.branch}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Disable integration failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not disable integration — ${message}`,
          );
          return;
        }
        treeProvider.refresh();
        void vscode.window.setStatusBarMessage(
          'Git Workflow: integration mode off',
          3000,
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.changeIntegrationBase',
      async () => {
        const integration = treeProvider.getIntegration();
        if (!integration) {
          return;
        }
        try {
          const picked = await pickBaseRef(
            integration.path,
            integrationBaseRef(),
          );
          if (!picked) {
            return;
          }
          // Workspace-scoped: the integration base is a property of this repo
          await vscode.workspace
            .getConfiguration('worktreeCompare')
            .update(
              'integrationBaseRef',
              picked,
              vscode.ConfigurationTarget.Workspace,
            );
          log.appendLine(`Integration base → ${picked}`);
          // The config-change handler triggers the rebuild
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Change integration base failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not change base — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.addToIntegration',
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath ?? treeProvider.getSelectedPath();
        const wt = target ? treeProvider.getWorktree(target) : undefined;
        if (!wt) {
          return;
        }
        try {
          await treeProvider.addIntegrationCandidate(wt.branch);
          void vscode.window.setStatusBarMessage(
            `Git Workflow: ${wt.branch} added — check it under Integration to merge it in`,
            4000,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Git Workflow: ${message}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.includeWipInIntegration',
      async (item?: { branch?: string }) => {
        if (!item?.branch) {
          return;
        }
        const result = await treeProvider.setLaneWip(item.branch, true);
        reportIntegrationResult(result, `wip on for ${item.branch}`);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.excludeWipFromIntegration',
      async (item?: { branch?: string }) => {
        if (!item?.branch) {
          return;
        }
        const result = await treeProvider.setLaneWip(item.branch, false);
        reportIntegrationResult(result, `wip off for ${item.branch}`);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.removeFromIntegration',
      async (item?: { branch?: string; worktreePath?: string }) => {
        const branch =
          item?.branch ??
          (item?.worktreePath
            ? treeProvider.getWorktree(item.worktreePath)?.branch
            : undefined);
        if (!branch) {
          return;
        }
        const result = await treeProvider.removeIntegrationCandidate(branch);
        reportIntegrationResult(result, `removed ${branch}`);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.applyToIntegration',
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath ?? treeProvider.getSelectedPath();
        const wt = target ? treeProvider.getWorktree(target) : undefined;
        if (!wt) {
          return;
        }
        const result = await treeProvider.applyToIntegration(wt.branch);
        reportIntegrationResult(result, `applied ${wt.branch}`);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.hideFromIntegration',
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath ?? treeProvider.getSelectedPath();
        const wt = target ? treeProvider.getWorktree(target) : undefined;
        if (!wt) {
          return;
        }
        const result = await treeProvider.hideFromIntegration(wt.branch);
        reportIntegrationResult(result, `hid ${wt.branch}`);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.rebuildIntegration',
      async () => {
        if (!treeProvider.getIntegration()) {
          void vscode.window.showInformationMessage(
            'Git Workflow: no integration worktree — check out the integration branch (default focus/working) in a worktree first',
          );
          return;
        }
        const result = await treeProvider.runIntegrationRebuild('manual');
        reportIntegrationResult(result, 'integration rebuilt');
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.abortIntegrationMerge',
      async () => {
        try {
          await treeProvider.abortIntegrationMerge();
          void vscode.window.setStatusBarMessage(
            'Git Workflow: integration merge aborted',
            3000,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Abort integration merge failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not abort merge — ${message}`,
          );
        }
      },
    ),
  ];
}

export function reportIntegrationResult(
  result: RebuildResult,
  successMessage: string,
): void {
  if (result.ok) {
    void vscode.window.setStatusBarMessage(
      `Git Workflow: ${successMessage} · lanes: ${
        result.lanes.length > 0 ? result.lanes.join(', ') : '(none)'
      }`,
      4000,
    );
    return;
  }
  if (result.code === 'busy') {
    void vscode.window.setStatusBarMessage(
      'Git Workflow: integration rebuild already running',
      3000,
    );
    return;
  }
  if (result.code === 'conflict') {
    void vscode.window.showWarningMessage(
      `Git Workflow: lane ${result.lane ?? ''} conflicts — resolve in the integration worktree or run Abort Integration Merge. ${result.message}`,
    );
    return;
  }
  void vscode.window.showErrorMessage(
    `Git Workflow: integration rebuild failed — ${result.message}`,
  );
}
