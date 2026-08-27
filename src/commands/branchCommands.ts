import * as vscode from 'vscode';
/** Command registrations — split by domain; wired from extension.ts. */
import { openRemotePrFileDiff } from '../compare/openDiff';
import { createWorktreeForBranch, suggestWorktreePath } from '../git/branches';
import { syncBranchWithRemote } from '../git/syncRemote';
import { ignoredFiles, isWorktreeDirty } from '../git/plumbing';
import { removeWorktree } from '../git/worktreeAdmin';
import { integrationBaseRef, integrationBranch } from '../git/integration';
import {
  findLandedBranches,
  pruneLandedBranches,
  type LandedBranch,
} from '../git/pruneLanded';
import { createWorktreeForPr } from '../github/remotePrs';
import type { BranchItem, RemotePrFileItem } from '../views/nodes/branches';
import type { BranchesTreeProvider } from '../views/branchesTree';
import type { WorktreeTreeProvider } from '../views/worktreeTree';


/**
 * A landed branch is often still checked out — its own worktree is the
 * usual reason it is on your disk at all. `git branch -D` cannot touch a
 * checked-out ref, so a prune that only deleted refs would refuse exactly
 * the rows the Landed group is showing you and leave the group unclearable.
 *
 * So prune removes the holding worktree first, under the same conditions
 * the landed quick-delete uses: clean, unlocked, attached, and holding no
 * ignored files. Ignored files are the one thing removal can still
 * destroy — the dirty probe cannot see them and `git worktree remove`
 * takes them without complaint — so a checkout holding any keeps its
 * folder, and says why.
 */
async function releaseHoldingWorktree(
  worktree: string,
  log: { appendLine(value: string): void },
): Promise<{ ok: true } | { ok: false; why: string }> {
  if (await isWorktreeDirty(worktree))
    return { ok: false, why: 'its checkout has uncommitted changes' };
  const ignored = await ignoredFiles(worktree);
  if (ignored.length > 0) {
    return {
      ok: false,
      why: `its checkout holds ignored files (${ignored.slice(0, 3).join(', ')})`,
    };
  }
  const removed = await removeWorktree(worktree, {});
  if (!removed.ok) return { ok: false, why: removed.message };
  log.appendLine(`Removed landed worktree ${worktree}`);
  return { ok: true };
}

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
          const chosen = args.branches.filter((b) => known.has(b));
          const blocked = new Map<string, string>();
        // Free the checkouts first: `git branch -D` cannot delete a
        // checked-out ref, so without this the prune refuses precisely the
        // rows Landed is showing.
        const holding = scan.landed.filter(
          (b) => b.worktree && chosen.includes(b.name),
        );
        for (const b of holding) {
          const freed = await releaseHoldingWorktree(b.worktree as string, log);
          if (!freed.ok) {
            log.appendLine(`Prune kept ${b.name}: ${freed.why}`);
            blocked.set(b.name, freed.why);
          }
        }
          const outcome = await pruneLandedBranches(
            repoCwd,
            baseRef,
            chosen.filter((b) => !blocked.has(b)),
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
          if (b.hasRemote) bits.push('origin still has it');
          if (b.worktree) bits.push('removes its checkout too');
          return bits.join(' · ');
        };
        const picked = await vscode.window.showQuickPick(
          scan.landed.map((b) => ({
            label: b.name,
            description: describe(b),
            // Held branches are selectable now: prune frees a clean
            // checkout before deleting the ref.
            picked: true,
            branch: b,
          })),
          {
            canPickMany: true,
            ignoreFocusOut: true,
            title: `Landed in ${baseRef} — delete locally?`,
            placeHolder: `${scan.landed.length} landed, ${scan.keptCount} kept`,
          },
        );
        if (!picked || picked.length === 0) return;
        const chosen = picked.map((p) => p.label);
        const blocked = new Map<string, string>();
        // Free the checkouts first: `git branch -D` cannot delete a
        // checked-out ref, so without this the prune refuses precisely the
        // rows Landed is showing.
        const holding = scan.landed.filter(
          (b) => b.worktree && chosen.includes(b.name),
        );
        for (const b of holding) {
          const freed = await releaseHoldingWorktree(b.worktree as string, log);
          if (!freed.ok) {
            log.appendLine(`Prune kept ${b.name}: ${freed.why}`);
            blocked.set(b.name, freed.why);
          }
        }
        const outcome = await pruneLandedBranches(
          repoCwd,
          baseRef,
          chosen.filter((b) => !blocked.has(b)),
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
        const kept = outcome.failed.size + blocked.size;
        void vscode.window.showInformationMessage(
          `Git Workflow: deleted ${outcome.deleted.length} branch(es)` +
            (kept > 0 ? ` — ${kept} kept, see the log for why` : ''),
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.syncWithRemote',
      async (item?: { branch?: string; worktreePath?: string }) => {
        const repoCwd = treeProvider.getRepoCwd();
        const branch =
          item?.branch ??
          (item?.worktreePath
            ? treeProvider.getWorktree(item.worktreePath)?.branch
            : undefined) ??
          treeProvider.getSelected()?.branch;
        if (!repoCwd || !branch) return;
        // A branch may be checked out somewhere other than the row clicked
        const worktree = treeProvider
          .getWorktrees()
          .find((w) => !w.detached && w.branch === branch)?.path;
        const result = await syncBranchWithRemote(repoCwd, branch, worktree);
        log.appendLine(`Sync ${branch}: ${result.status}`);
        switch (result.status) {
          case 'up-to-date':
            void vscode.window.setStatusBarMessage(
              `Git Workflow: ${branch} is up to date with origin`,
              2500,
            );
            break;
          case 'published':
            void vscode.window.showInformationMessage(
              `Git Workflow: published ${branch} to origin`,
            );
            break;
          case 'fast-forwarded':
            void vscode.window.showInformationMessage(
              `Git Workflow: ${branch} fast-forwarded ${result.behind} commit(s) from origin`,
            );
            break;
          case 'pushed':
            void vscode.window.showInformationMessage(
              `Git Workflow: pushed ${result.ahead} commit(s) of ${branch}`,
            );
            break;
          case 'diverged':
            // Deliberately not decided here: choosing merge puts a merge
            // commit in the PR, choosing rebase force-pushes over whatever
            // is already on origin. Catch Up exists for exactly this.
            void vscode.window
              .showWarningMessage(
                `Git Workflow: ${branch} and origin/${branch} have both moved (${result.ahead} local, ${result.behind} remote). Sync will not choose for you — someone else's commits are on origin.`,
                'Catch Up with Base…',
              )
              .then((choice) => {
                if (choice) {
                  void vscode.commands.executeCommand(
                    'worktreeCompare.catchUpWithBase',
                    item,
                  );
                }
              });
            break;
          case 'no-remote':
            void vscode.window.showInformationMessage(
              'Git Workflow: this repository has no origin remote',
            );
            break;
          default:
            void vscode.window.showErrorMessage(
              `Git Workflow: sync failed — ${result.message}`,
            );
        }
        if (result.status !== 'up-to-date' && result.status !== 'diverged') {
          treeProvider.refresh();
          branchesProvider.setWorktrees(treeProvider.getWorktrees());
          branchesProvider.refresh();
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.openRemotePrFile',
      async (item?: RemotePrFileItem) => {
        if (!item) return;
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
        if (!item?.branch) return;
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
        if (!dest?.trim()) return;

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
