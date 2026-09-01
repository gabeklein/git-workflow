import * as path from 'node:path';
import * as vscode from 'vscode';
/** Command registrations — split by domain; wired from extension.ts. */
import { pickBaseRef } from '../compare/pickBaseRef';
import { git, gitOk } from '../git/exec';
import {
  clearBasePin,
  deletePreviewBranch,
  previewBaseRef,
  previewBranch,
  switchAwayFromPreview,
  switchToPreviewBranch,
  type RebuildResult,
} from '../git/preview';
import {
  createWorktreeForBranch,
  suggestWorktreePath,
} from '../git/branches';
import { unexcludeWorkspaceSettings } from '../git/exclude';
import { isWorktreeDirty } from '../git/plumbing';
import { listWorktreeAdmin } from '../git/worktreeAdmin';
import type { WorktreeTreeProvider } from '../views/worktreeTree';

/** Branch the root checkout was on before enabling preview on it. */
const PREVIEW_RETURN_KEY = 'worktreeCompare.previewReturnBranch';

export function registerPreviewCommands(
  context: vscode.ExtensionContext,
  treeProvider: WorktreeTreeProvider,
  log: { appendLine(value: string): void },
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      'worktreeCompare.enablePreview',
      async () => {
        if (treeProvider.getPreview()) {
          void vscode.window.showInformationMessage(
            'Git Workflow: preview mode is already on',
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
        const branch = previewBranch();
        const baseRef = previewBaseRef();
        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? repoCwd;

        const confirm = await vscode.window.showInformationMessage(
          [
            `Switch ${path.basename(workspaceRoot)} to ${branch}?`,
            '',
            'The workspace root becomes the preview: checked lanes appear',
            'right here, and the tree is rebuilt from the base on every',
            'change. Nothing can be committed here — a pre-commit hook',
            'refuses, and uncommitted edits are moved onto a real branch',
            'by Absorb Preview Edits.',
          ].join('\n'),
          { modal: true },
          'Enable Preview',
        );
        if (confirm !== 'Enable Preview') return;

        try {
          // Enabling re-freezes the base at NOW — a stale pin from a
          // previous session must not resurrect an old base.
          await clearBasePin(repoCwd).catch(() => {});
          if (await isWorktreeDirty(workspaceRoot)) {
            void vscode.window.showErrorMessage(
              `Git Workflow: this checkout has uncommitted changes — commit or stash before switching to ${branch}`,
            );
            return;
          }
          const previous = await switchToPreviewBranch(workspaceRoot, baseRef);
          await context.workspaceState.update(PREVIEW_RETURN_KEY, previous);
          log.appendLine(
            `Preview mode on: ${workspaceRoot} switched ${previous ?? '(detached)'} → ${branch}`,
          );
          treeProvider.refresh();
          void vscode.window.showInformationMessage(
            'Git Workflow: preview mode on — add worktrees via their context menu, then check the lanes under the preview row',
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Enable preview failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not enable preview — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.disablePreview',
      async () => {
        const preview = treeProvider.getPreview();
        if (!preview) return;
        const confirm = await vscode.window.showWarningMessage(
          [
            'Disable preview mode?',
            '',
            `This switches ${preview.path} off ${preview.branch} (back to your previous branch), discarding derived state.`,
            '',
            `The ${preview.branch} branch is deleted (it is derived state). The lane list is kept — enabling again restores the same lanes.`,
          ].join('\n'),
          { modal: true },
          'Disable',
        );
        if (confirm !== 'Disable') return;
        try {
          const returned = await switchAwayFromPreview(
            preview.path,
            context.workspaceState.get<string>(PREVIEW_RETURN_KEY),
            previewBaseRef(),
            preview.branch,
          );
          await context.workspaceState.update(PREVIEW_RETURN_KEY, undefined);
          log.appendLine(
            `Preview mode off: ${preview.path} switched back to ${returned.branch}`,
          );
          // The local base sat still for the whole session while the
          // preview tracked origin; say so, since the tree just changed.
          if (returned.fastForwarded) {
            const ff = returned.fastForwarded;
            log.appendLine(
              `Fast-forwarded ${ff.branch} to origin/${ff.branch} (${ff.from.slice(0, 7)} → ${ff.to.slice(0, 7)})`,
            );
          }
          // Branch is derived state — delete so nothing straggles. The
          // checkout survives the switch-away, so it is a valid cwd.
          const cwd = preview.path;
          if (await deletePreviewBranch(cwd))
            log.appendLine(`Preview branch deleted: ${preview.branch}`);
          await clearBasePin(cwd).catch(() => {});
          // The root is a normal checkout again, so its settings file goes
          // back to being an ordinary untracked file of the user's own.
          await unexcludeWorkspaceSettings(preview.path).catch(() => {});
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Disable preview failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not disable preview — ${message}`,
          );
          return;
        }
        treeProvider.refresh();
        void vscode.window.setStatusBarMessage(
          'Git Workflow: preview mode off',
          3000,
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.changePreviewBase',
      async () => {
        const preview = treeProvider.getPreview();
        if (!preview) return;
        try {
          const picked = await pickBaseRef(
            preview.path,
            previewBaseRef(),
          );
          if (!picked) return;
          // Workspace-scoped: the preview base is a property of this repo
          await vscode.workspace
            .getConfiguration('worktreeCompare')
            .update(
              'previewBaseRef',
              picked,
              vscode.ConfigurationTarget.Workspace,
            );
          log.appendLine(`Preview base → ${picked}`);
          // The config-change handler triggers the rebuild
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Change preview base failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not change base — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.catchUpPreviewBase',
      async () => {
        const result = await treeProvider.catchUpPreviewBase();
        reportPreviewResult(result, 'preview base caught up');
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.branchifyBaseDrift',
      // nameArg: menus pass nothing (prompt); tests/automation may pass
      // the branch name directly.
      async (nameArg?: unknown) => {
        const preview = treeProvider.getPreview();
        const drift = preview?.baseDrift;
        if (!preview || !drift) return;
        const baseName = previewBaseRef().replace(/^origin\//, '');
        // The base branch may be checked out (often a clean root that the
        // Worktrees list hides) — resolve its checkout from git itself,
        // because moving the ref under a live checkout must reset there.
        let baseCheckoutPath: string | undefined;
        try {
          const admin = await listWorktreeAdmin(preview.path);
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
        if (!name?.trim()) return;
        const branch = name.trim();
        try {
          if (
            await gitOk(preview.path, [
              'show-ref',
              '--verify',
              '--quiet',
              `refs/heads/${branch}`,
            ])
          ) {
            throw new Error(`branch ${branch} already exists`);
          }
          await git(preview.path, ['branch', branch, drift.sha]);
          // Record where the branch forked: created from a raw sha, its
          // reflog says 'Created from <sha>' and inference would resolve
          // the base to its own tip (0 ahead, empty diff). This config key
          // is inference's first stop; genuineBaseFor reads it too, so the
          // branch also auto-enrolls as an preview member by base.
          await git(preview.path, [
            'config',
            `branch.${branch}.vscode-merge-base`,
            baseName,
          ]);
          if (baseCheckoutPath) {
            // --keep refuses rather than clobber local file changes
            await git(baseCheckoutPath, ['reset', '--keep', drift.resetTo]);
          } else {
            await git(preview.path, [
              'update-ref',
              `refs/heads/${baseName}`,
              drift.resetTo,
              drift.sha,
            ]);
          }
          log.appendLine(
            `Base drift → ${branch}: ${drift.ahead} commit(s) moved off ${baseName} (${baseName} back at ${drift.resetTo.slice(0, 10)})`,
          );
          const result = await treeProvider.applyToPreview(branch);
          reportPreviewResult(
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
                if (pick !== 'Create Worktree') return;
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
      'worktreeCompare.addToPreview',
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath ?? treeProvider.getSelectedPath();
        const wt = target ? treeProvider.getWorktree(target) : undefined;
        if (!wt) return;
        try {
          // Adding means "put it in the preview": applied immediately —
          // the checkbox is for taking a lane OUT, not for finishing an add
          const result = await treeProvider.applyToPreview(wt.branch);
          reportPreviewResult(result, `added ${wt.branch} to the preview`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Git Workflow: ${message}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.includeWipInPreview',
      async (item?: { branch?: string }) => {
        if (!item?.branch) return;
        const result = await treeProvider.setLaneWip(item.branch, true);
        reportPreviewResult(result, `wip on for ${item.branch}`);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.excludeWipFromPreview',
      async (item?: { branch?: string }) => {
        if (!item?.branch) return;
        const result = await treeProvider.setLaneWip(item.branch, false);
        reportPreviewResult(result, `wip off for ${item.branch}`);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.removeFromPreview',
      async (item?: { branch?: string; worktreePath?: string }) => {
        const branch =
          item?.branch ??
          (item?.worktreePath
            ? treeProvider.getWorktree(item.worktreePath)?.branch
            : undefined);
        if (!branch) return;
        const result = await treeProvider.removePreviewCandidate(branch);
        reportPreviewResult(result, `removed ${branch}`);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.applyToPreview',
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath ?? treeProvider.getSelectedPath();
        const wt = target ? treeProvider.getWorktree(target) : undefined;
        if (!wt) return;
        const result = await treeProvider.applyToPreview(wt.branch);
        reportPreviewResult(result, `applied ${wt.branch}`);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.hideFromPreview',
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath ?? treeProvider.getSelectedPath();
        const wt = target ? treeProvider.getWorktree(target) : undefined;
        if (!wt) return;
        const result = await treeProvider.hideFromPreview(wt.branch);
        reportPreviewResult(result, `hid ${wt.branch}`);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.rebuildPreview',
      async () => {
        if (!treeProvider.getPreview()) {
          void vscode.window.showInformationMessage(
            'Git Workflow: preview mode is off — enable it to rebuild (Git Workflow: Enable Preview Mode)',
          );
          return;
        }
        const result = await treeProvider.runPreviewRebuild('manual');
        reportPreviewResult(result, 'preview rebuilt');
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.absorbPreviewCommits',
      async () => {
        const result = await treeProvider.absorbPreviewCommits();
        if (!result) return;
        if (result.ok) {
          void vscode.window.showInformationMessage(
            `Git Workflow: moved ${result.commits} commit(s) onto ${path.basename(result.target)} — they show as unpushed base work.`,
          );
          return;
        }
        log.appendLine(`Absorb preview commits failed: ${result.message}`);
        void vscode.window.showErrorMessage(
          result.code === 'conflict'
            ? `Git Workflow: those commits clash with the base${
                result.files?.length ? ` in ${result.files.join(', ')}` : ''
              } — nothing was moved.`
            : `Git Workflow: could not absorb — ${result.message}`,
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.absorbPreviewEdits',
      async () => {
        const result = await treeProvider.absorbPreviewEdits();
        if (result.ok) {
          void vscode.window.showInformationMessage(
            `Git Workflow: moved the preview checkout's uncommitted edits onto ${path.basename(result.target)} — review and commit them there.`,
          );
          return;
        }
        if (result.code === 'nothing') {
          void vscode.window.setStatusBarMessage(
            'Git Workflow: preview checkout is clean — nothing to absorb',
            3000,
          );
          return;
        }
        log.appendLine(`Absorb preview edits failed: ${result.message}`);
        void vscode.window.showErrorMessage(
          result.code === 'conflict'
            ? `Git Workflow: those edits clash with the base${
                result.files?.length ? ` in ${result.files.join(', ')}` : ''
              } — they were left in the preview checkout. Move them onto the lane they belong to instead.`
            : `Git Workflow: could not absorb — ${result.message}`,
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.abortPreviewMerge',
      async () => {
        try {
          await treeProvider.abortPreviewMerge();
          void vscode.window.setStatusBarMessage(
            'Git Workflow: preview merge aborted',
            3000,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Abort preview merge failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not abort merge — ${message}`,
          );
        }
      },
    ),
  ];
}

export function reportPreviewResult(
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
      'Git Workflow: preview rebuild already running',
      3000,
    );
    return;
  }
  if (result.code === 'conflict') {
    void vscode.window.showWarningMessage(
      `Git Workflow: lane ${result.lane ?? ''} conflicts — resolve in the preview checkout or run Abort Preview Merge. ${result.message}`,
    );
    return;
  }
  void vscode.window.showErrorMessage(
    `Git Workflow: preview rebuild failed — ${result.message}`,
  );
}
