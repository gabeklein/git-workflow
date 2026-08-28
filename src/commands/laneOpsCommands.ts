import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiscoveredWorktree } from '../git/discovery';
import { git } from '../git/exec';
import { catchUpStrategy, integrationBaseRef } from '../git/integration';
import {
  abortBaseMerge,
  abortLaneRebase,
  completeBaseMerge,
  continueLaneRebase,
  startBaseMerge,
  startLaneRebase,
  type LaneOpResult,
} from '../git/laneOps';
import type { WorktreeTreeProvider } from '../views/worktreeTree';

/**
 * Manual catch-up commands: bring a lane up to date with ITS base (the
 * same per-worktree base the row badges are computed against), pause on
 * conflicts for the editor's merge UI, and continue/abort from the row.
 */
export function registerLaneOpsCommands(
  treeProvider: WorktreeTreeProvider,
  log: { appendLine(value: string): void },
): vscode.Disposable[] {
  /** Menu items pass worktreePath (worktree rows) or branch (lane rows). */
  function resolveWorktree(item?: {
    worktreePath?: string;
    branch?: string;
  }): DiscoveredWorktree | undefined {
    if (item?.worktreePath) return treeProvider.getWorktree(item.worktreePath);
    if (item?.branch) {
      return treeProvider
        .getWorktrees()
        .find((w) => !w.detached && w.branch === item.branch);
    }
    const selected = treeProvider.getSelectedPath();
    return selected ? treeProvider.getWorktree(selected) : undefined;
  }

  async function refreshRows(): Promise<void> {
    treeProvider.refresh();
    await treeProvider.refreshBaseStatuses();
  }

  /** Open the first conflicted files so the merge-conflict UI takes over. */
  async function openConflicted(
    worktreePath: string,
    files: string[],
  ): Promise<void> {
    for (const f of files.slice(0, 3)) {
      await vscode.window.showTextDocument(
        vscode.Uri.file(path.join(worktreePath, f)),
        { preview: false },
      );
    }
  }

  async function runRebase(wt: DiscoveredWorktree, baseRef: string) {
    // Captured BEFORE the rebase: a paused rebase detaches HEAD, and a
    // finished one must offer force-push based on what the branch was.
    const { branch, path: worktreePath, publishState } = wt;
    const result = await startLaneRebase(worktreePath, baseRef);
    await handleRebaseResult(result, worktreePath, branch, baseRef, publishState);
  }

  async function handleRebaseResult(
    result: LaneOpResult,
    worktreePath: string,
    branch: string,
    baseRef: string,
    publishState: DiscoveredWorktree['publishState'],
  ): Promise<void> {
    if (result.status === 'done') {
      log.appendLine(`Lane ${branch}: rebased onto ${baseRef}`);
      await refreshRows();
      if (publishState === 'pushed') {
        // History rewritten — the remote branch is now stale
        const pick = await vscode.window.showWarningMessage(
          `Git Workflow: ${branch} rebased onto ${baseRef} — origin/${branch} still has the old history.`,
          'Force Push (with lease)',
        );
        if (pick === 'Force Push (with lease)') {
          try {
            await git(worktreePath, [
              'push',
              '--force-with-lease',
              'origin',
              branch,
            ]);
            void vscode.window.setStatusBarMessage(
              `Git Workflow: force-pushed ${branch}`,
              3000,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(
              `Git Workflow: force push failed — ${message}`,
            );
          }
        }
      } else {
        void vscode.window.setStatusBarMessage(
          `Git Workflow: ${branch} rebased onto ${baseRef}`,
          4000,
        );
      }
      return;
    }
    if (result.status === 'conflicts') {
      await openConflicted(worktreePath, result.files);
      await refreshRows();
      void vscode.window.showInformationMessage(
        `Git Workflow: rebase paused on ${result.files.join(', ')} — resolve the markers, then Continue Rebase on the ${branch} row`,
      );
      return;
    }
    void vscode.window.showWarningMessage(
      `Git Workflow: rebase not started — ${result.message}`,
    );
  }

  async function runMerge(wt: DiscoveredWorktree, baseRef: string) {
    const { branch, path: worktreePath } = wt;
    const result = await startBaseMerge(worktreePath, baseRef, branch);
    if (result.status === 'done') {
      log.appendLine(`Lane ${branch}: merged ${baseRef}`);
      await refreshRows();
      void vscode.window.setStatusBarMessage(
        `Git Workflow: merged ${baseRef} into ${branch}`,
        4000,
      );
      return;
    }
    if (result.status === 'conflicts') {
      await openConflicted(worktreePath, result.files);
      await refreshRows();
      void vscode.window.showInformationMessage(
        `Git Workflow: merge paused on ${result.files.join(', ')} — resolve the markers, then Complete Merge from Base on the ${branch} row`,
      );
      return;
    }
    void vscode.window.showWarningMessage(
      `Git Workflow: merge not started — ${result.message}`,
    );
  }

  return [
    vscode.commands.registerCommand(
      'worktreeCompare.catchUpWithBase',
      async (item?: { worktreePath?: string }) => {
        const wt = resolveWorktree(item);
        if (!wt) return;
        const baseRef = await treeProvider.worktreeBaseFor(wt.path);
        const strategy = catchUpStrategy();
        const viaMerge =
          strategy === 'merge' ||
          (strategy === 'auto' && wt.publishState === 'pushed');
        if (viaMerge) {
          await runMerge(wt, baseRef);
        } else {
          await runRebase(wt, baseRef);
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.rebaseOntoBase',
      async (item?: { worktreePath?: string }) => {
        const wt = resolveWorktree(item);
        if (!wt) return;
        await runRebase(wt, await treeProvider.worktreeBaseFor(wt.path));
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.mergeFromBase',
      async (item?: { worktreePath?: string }) => {
        const wt = resolveWorktree(item);
        if (!wt) return;
        await runMerge(wt, await treeProvider.worktreeBaseFor(wt.path));
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.resolveLaneConflict',
      async (item?: { branch?: string; worktreePath?: string }) => {
        const wt = resolveWorktree(item);
        if (!wt) {
          void vscode.window.showErrorMessage(
            `Git Workflow: ${item?.branch ?? 'lane'} has no worktree — create one from the Branches panel first`,
          );
          return;
        }
        // Integration lane rows resolve against the INTEGRATION base —
        // that is the conflict the lane badge reported.
        await runMerge(wt, integrationBaseRef());
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.continueRebase',
      async (item?: { worktreePath?: string }) => {
        const wt = resolveWorktree(item);
        if (!wt) return;
        const baseRef = await treeProvider.worktreeBaseFor(wt.path);
        const result = await continueLaneRebase(wt.path);
        await handleRebaseResult(
          result,
          wt.path,
          wt.branch,
          baseRef,
          wt.publishState,
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.abortRebase',
      async (item?: { worktreePath?: string }) => {
        const wt = resolveWorktree(item);
        if (!wt) return;
        try {
          await abortLaneRebase(wt.path);
          await refreshRows();
          void vscode.window.setStatusBarMessage(
            'Git Workflow: rebase aborted',
            3000,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not abort rebase — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.completeMergeFromBase',
      async (item?: { branch?: string; worktreePath?: string }) => {
        const wt = resolveWorktree(item);
        if (!wt) return;
        // Captured before the commit flips the state
        const { branch, path: worktreePath, publishState } = wt;
        const result = await completeBaseMerge(worktreePath);
        if (result.status !== 'done') {
          const message =
            'message' in result
              ? result.message
              : `still unmerged: ${result.files.join(', ')}`;
          void vscode.window.showWarningMessage(
            `Git Workflow: merge not complete — ${message}`,
          );
          return;
        }
        log.appendLine(`Lane ${branch}: base merge committed`);
        await refreshRows();
        if (publishState === 'pushed') {
          const pick = await vscode.window.showInformationMessage(
            `Git Workflow: ${branch} merge committed — push to update origin?`,
            'Push',
          );
          if (pick === 'Push') {
            try {
              await git(worktreePath, ['push', 'origin', branch]);
              void vscode.window.setStatusBarMessage(
                `Git Workflow: pushed ${branch}`,
                3000,
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              void vscode.window.showErrorMessage(
                `Git Workflow: push failed — ${message}`,
              );
            }
          }
        } else {
          void vscode.window.setStatusBarMessage(
            `Git Workflow: ${branch} merge committed`,
            4000,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.abortMergeFromBase',
      async (item?: { branch?: string; worktreePath?: string }) => {
        const wt = resolveWorktree(item);
        if (!wt) return;
        try {
          await abortBaseMerge(wt.path);
          await refreshRows();
          void vscode.window.setStatusBarMessage(
            `Git Workflow: ${wt.branch} merge aborted`,
            3000,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not abort merge — ${message}`,
          );
        }
      },
    ),
  ];
}
