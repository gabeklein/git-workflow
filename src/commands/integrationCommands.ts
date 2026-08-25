import * as path from 'node:path';
import * as vscode from 'vscode';
/** Command registrations — split by domain; wired from extension.ts. */
import { pickBaseRef } from '../compare/pickBaseRef';
import { git, gitOk } from '../git/exec';
import {
  clearBasePin,
  createIntegrationWorktree,
  deleteIntegrationBranch,
  integrationBaseRef,
  integrationBranch,
  switchAwayFromIntegration,
  switchToIntegrationBranch,
  type RebuildResult,
} from '../git/integration';
import {
  createWorktreeForBranch,
  suggestWorktreePath,
} from '../git/branches';
import { isWorktreeDirty } from '../git/plumbing';
import { listWorktreeAdmin, removeWorktree } from '../git/worktreeAdmin';
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
          // Enabling re-freezes the base at NOW — a stale pin from a
          // previous session must not resurrect an old base.
          await clearBasePin(repoCwd).catch(() => {});
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
          if (cwd) {
            await clearBasePin(cwd).catch(() => {});
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
      'worktreeCompare.catchUpIntegrationBase',
      async () => {
        const result = await treeProvider.catchUpIntegrationBase();
        reportIntegrationResult(result, 'integration base caught up');
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.branchifyBaseDrift',
      // nameArg: menus pass nothing (prompt); tests/automation may pass
      // the branch name directly.
      async (nameArg?: unknown) => {
        const integration = treeProvider.getIntegration();
        const drift = integration?.baseDrift;
        if (!integration || !drift) {
          return;
        }
        const baseName = integrationBaseRef().replace(/^origin\//, '');
        // The base branch may be checked out (often a clean root that the
        // Worktrees list hides) — resolve its checkout from git itself,
        // because moving the ref under a live checkout must reset there.
        let baseCheckoutPath: string | undefined;
        try {
          const admin = await listWorktreeAdmin(integration.path);
          baseCheckoutPath = [...admin.values()].find(
            (s) => !s.detached && s.branch === baseName,
          )?.path;
        } catch {
          // fall through — update-ref path below handles no-checkout
        }
        // TRACKED changes only: untracked files (.vscode/, scratch) never
        // block — reset --keep leaves them alone and refuses on its own
        // if content would actually be lost.
        const trackedDirty = baseCheckoutPath
          ? (
              await git(baseCheckoutPath, [
                'status',
                '--porcelain=v1',
                '-uno',
                '--ignore-submodules=dirty',
              ]).catch(() => '')
            ).trim().length > 0
          : false;
        if (trackedDirty) {
          void vscode.window.showErrorMessage(
            `Git Workflow: ${baseCheckoutPath} has uncommitted changes — commit or stash before moving ${baseName}'s commits to a branch`,
          );
          return;
        }
        const name =
          typeof nameArg === 'string' && nameArg.trim()
            ? nameArg
            : await vscode.window.showInputBox({
                prompt: `Branch for the ${drift.ahead} commit(s) on ${baseName}`,
                value: `${baseName}-work`,
                ignoreFocusOut: true,
                validateInput: (v) =>
                  v.trim() ? undefined : 'Branch name is required',
              });
        if (!name?.trim()) {
          return;
        }
        const branch = name.trim();
        try {
          if (
            await gitOk(integration.path, [
              'show-ref',
              '--verify',
              '--quiet',
              `refs/heads/${branch}`,
            ])
          ) {
            throw new Error(`branch ${branch} already exists`);
          }
          await git(integration.path, ['branch', branch, drift.sha]);
          // Record where the branch forked: created from a raw sha, its
          // reflog says 'Created from <sha>' and inference would resolve
          // the base to its own tip (0 ahead, empty diff). This config key
          // is inference's first stop; genuineBaseFor reads it too, so the
          // branch also auto-enrolls as an integration member by base.
          await git(integration.path, [
            'config',
            `branch.${branch}.vscode-merge-base`,
            baseName,
          ]);
          if (baseCheckoutPath) {
            // --keep refuses rather than clobber local file changes
            await git(baseCheckoutPath, ['reset', '--keep', drift.resetTo]);
          } else {
            await git(integration.path, [
              'update-ref',
              `refs/heads/${baseName}`,
              drift.resetTo,
              drift.sha,
            ]);
          }
          log.appendLine(
            `Base drift → ${branch}: ${drift.ahead} commit(s) moved off ${baseName} (${baseName} back at ${drift.resetTo.slice(0, 10)})`,
          );
          const result = await treeProvider.applyToIntegration(branch);
          reportIntegrationResult(
            result,
            `moved ${drift.ahead} commit(s) to ${branch}`,
          );
          treeProvider.refresh();
          // Branchified drift is usually work someone wants to CONTINUE —
          // offer the checkout. Not awaited: nothing depends on the answer.
          const workspaceRoot =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
            treeProvider.getRepoCwd();
          const repoCwd = treeProvider.getRepoCwd();
          if (workspaceRoot && repoCwd) {
            void vscode.window
              .showInformationMessage(
                `Git Workflow: ${branch} holds the moved commits — create a worktree to keep working on it?`,
                'Create Worktree',
              )
              .then(async (pick) => {
                if (pick !== 'Create Worktree') {
                  return;
                }
                try {
                  const dest = suggestWorktreePath(
                    workspaceRoot,
                    branch.replace(/[^\w.-]+/g, '-'),
                  );
                  await createWorktreeForBranch(repoCwd, branch, true, dest);
                  log.appendLine(`Worktree created for ${branch}: ${dest}`);
                  treeProvider.refresh();
                  void vscode.window.setStatusBarMessage(
                    `Git Workflow: worktree created at ${dest}`,
                    4000,
                  );
                } catch (err) {
                  const message =
                    err instanceof Error ? err.message : String(err);
                  void vscode.window.showErrorMessage(
                    `Git Workflow: could not create worktree — ${message}`,
                  );
                }
              });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Branchify base drift failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not move commits — ${message}`,
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
          // Adding means "put it in the preview": applied immediately —
          // the checkbox is for taking a lane OUT, not for finishing an add
          const result = await treeProvider.applyToIntegration(wt.branch);
          reportIntegrationResult(result, `added ${wt.branch} to the preview`);
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
      'worktreeCompare.absorbIntegrationEdits',
      async () => {
        const result = await treeProvider.absorbIntegrationEdits();
        if (result.ok) {
          void vscode.window.showInformationMessage(
            `Git Workflow: moved the integration checkout's uncommitted edits onto ${path.basename(result.target)} — review and commit them there.`,
          );
          return;
        }
        if (result.code === 'nothing') {
          void vscode.window.setStatusBarMessage(
            'Git Workflow: integration checkout is clean — nothing to absorb',
            3000,
          );
          return;
        }
        log.appendLine(`Absorb integration edits failed: ${result.message}`);
        void vscode.window.showErrorMessage(
          result.code === 'conflict'
            ? `Git Workflow: those edits clash with the base${
                result.files?.length ? ` in ${result.files.join(', ')}` : ''
              } — they were left in the integration checkout. Move them onto the lane they belong to instead.`
            : `Git Workflow: could not absorb — ${result.message}`,
        );
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
