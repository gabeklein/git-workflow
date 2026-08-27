import * as vscode from 'vscode';
/** Command registrations — split by domain; wired from extension.ts. */
import { openRemotePrFileDiff } from '../compare/openDiff';
import { createWorktreeForBranch, suggestWorktreePath } from '../git/branches';
import { integrationBaseRef, integrationBranch } from '../git/integration';
import {
  findLandedBranches,
  pruneLandedBranches,
  type LandedBranch,
} from '../git/pruneLanded';
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
      'worktreeCompare.pruneLandedBranches',
      // An agent (or a test) can pass the names outright and skip the
      // picker. It still re-verifies every one against the base before
      // deleting, so scripting this is not a way around the proof.
      async (args?: { branches?: string[] }) => {
        const repoCwd = treeProvider.getRepoCwd();
        if (!repoCwd) {
          void vscode.window.showErrorMessage(
            'Git Workflow: no git repository found in this workspace',
          );
          return;
        }
        const baseRef = integrationBaseRef();
        // The integration branch is derived, and the base is the thing we
        // are measuring against — neither is a unit of work.
        const protect = [integrationBranch()];
        let scan: Awaited<ReturnType<typeof findLandedBranches>>;
        try {
          scan = await findLandedBranches(repoCwd, baseRef, protect);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Prune landed branches failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not scan branches — ${message}`,
          );
          return;
        }
        if (scan.landed.length === 0) {
          void vscode.window.showInformationMessage(
            scan.keptCount > 0
              ? `Git Workflow: nothing landed in ${baseRef} — ${scan.keptCount} branch(es) still have work of their own`
              : `Git Workflow: no local branches to prune`,
          );
          return;
        }
        if (args?.branches) {
          const known = new Set(scan.landed.map((b) => b.name));
          const unknown = args.branches.filter((b) => !known.has(b));
          for (const name of unknown) {
            log.appendLine(`Prune skipped ${name}: not landed in ${baseRef}`);
          }
          const outcome = await pruneLandedBranches(
            repoCwd,
            baseRef,
            args.branches.filter((b) => known.has(b)),
            protect,
          );
          for (const [name, why] of outcome.failed) {
            log.appendLine(`Prune kept ${name}: ${why}`);
          }
          if (outcome.deleted.length > 0) {
            log.appendLine(
              `Pruned landed branches: ${outcome.deleted.join(', ')}`,
            );
            treeProvider.refresh();
            branchesProvider.setWorktrees(treeProvider.getWorktrees());
            branchesProvider.refresh();
          }
          return;
        }
        const describe = (b: LandedBranch): string => {
          const bits = [
            b.via === 'ancestor' ? 'merged' : 'squashed or rebased in',
          ];
          if (b.hasRemote) {
            bits.push('origin still has it');
          }
          if (b.worktree) {
            bits.push('checked out — remove the worktree first');
          }
          return bits.join(' · ');
        };
        const picked = await vscode.window.showQuickPick(
          scan.landed.map((b) => ({
            label: b.name,
            description: describe(b),
            // Held branches cannot be deleted, so they are shown (you should
            // know they are done) but never pre-selected.
            picked: !b.worktree,
            branch: b,
          })),
          {
            canPickMany: true,
            ignoreFocusOut: true,
            title: `Landed in ${baseRef} — delete locally?`,
            placeHolder: `${scan.landed.length} landed, ${scan.keptCount} kept`,
          },
        );
        if (!picked || picked.length === 0) {
          return;
        }
        const outcome = await pruneLandedBranches(
          repoCwd,
          baseRef,
          picked.map((p) => p.label),
          protect,
        );
        for (const [name, why] of outcome.failed) {
          log.appendLine(`Prune kept ${name}: ${why}`);
        }
        if (outcome.deleted.length > 0) {
          log.appendLine(
            `Pruned landed branches: ${outcome.deleted.join(', ')}`,
          );
          treeProvider.refresh();
          branchesProvider.setWorktrees(treeProvider.getWorktrees());
          branchesProvider.refresh();
        }
        const kept = outcome.failed.size;
        void vscode.window.showInformationMessage(
          `Git Workflow: deleted ${outcome.deleted.length} branch(es)` +
            (kept > 0 ? ` — ${kept} kept, see the log for why` : ''),
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
