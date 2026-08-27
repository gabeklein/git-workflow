import * as path from 'node:path';
import * as vscode from 'vscode';
/** Command registrations — split by domain; wired from extension.ts. */
import {
  openCommitFileDiff,
  openStagedDiff,
  openUnstagedDiff,
  openWorkingTreeDiff,
} from '../compare/openDiff';
import { pickBaseRef } from '../compare/pickBaseRef';
import { pickWorktree } from '../compare/pickWorktree';
import { commitStaged, commitUnstagedPaths } from '../git/commit';
import { findLandedLanes, isQuickDeleteLandedEnabled } from '../git/integration';
import { ignoredFiles, isWorktreeDirty } from '../git/plumbing';
import { getWorkingStatus } from '../git/status';
import { stagePaths, unstagePaths } from '../git/stage';
import { removeWorktree, unlockWorktree } from '../git/worktreeAdmin';
import type { SectionItem } from '../views/nodes';
import type { FileItem } from '../views/nodes/files';
import type { CommitItem } from '../views/nodes/worktrees';
import type { WorktreeTreeProvider } from '../views/worktreeTree';

export function registerWorktreeCommands(
  treeProvider: WorktreeTreeProvider,
  log: { appendLine(value: string): void; logFile: string },
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('worktreeCompare.refresh', () => {
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand(
      'worktreeCompare.toggleSquashLayout',
      async () => {
        const config = vscode.workspace.getConfiguration('worktreeCompare');
        const current = config.get<string>('squashLayout', 'list');
        const next = current === 'tree' ? 'list' : 'tree';
        await config.update(
          'squashLayout',
          next,
          vscode.ConfigurationTarget.Global,
        );
        // Refresh only selected worktree body (not full rediscovery)
        const selected = treeProvider.getSelectedPath();
        if (selected) {
          treeProvider.refreshCompare(selected);
        } else {
          treeProvider.refresh();
        }
        void vscode.window.setStatusBarMessage(
          `Git Workflow: Full Diff layout → ${next}`,
          2500,
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.focusWorktree',
      async (pathOrItem?: string | { worktreePath?: string }) => {
        const path =
          typeof pathOrItem === 'string'
            ? pathOrItem
            : pathOrItem?.worktreePath;
        if (!path) return;
        await treeProvider.setSelectedPath(path);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.selectWorktree',
      async () => {
        const picked = await pickWorktree(
          treeProvider.getWorktrees(),
          treeProvider.getSelectedPath(),
        );
        if (!picked) return;
        await treeProvider.setSelectedPath(picked.path);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.openWorktree',
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath ?? treeProvider.getSelectedPath();
        if (!target) return;
        const uri = vscode.Uri.file(target);
        // revealInExplorer can only show what the Explorer already holds —
        // a worktree in a sibling directory is outside every workspace
        // folder, so the command silently did nothing. Fall back to the OS
        // file manager, which can show any path.
        const inWorkspace = Boolean(vscode.workspace.getWorkspaceFolder(uri));
        try {
          await vscode.commands.executeCommand(
            inWorkspace ? 'revealInExplorer' : 'revealFileInOS',
            uri,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Reveal worktree failed (${target}): ${message}`);
          await vscode.commands.executeCommand('revealFileInOS', uri);
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.unlockWorktree',
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath ?? treeProvider.getSelectedPath();
        if (!target) return;
        try {
          await unlockWorktree(target);
          log.appendLine(`Unlocked worktree ${target}`);
          treeProvider.refresh();
          void vscode.window.setStatusBarMessage(
            'Git Workflow: worktree unlocked',
            2500,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Unlock worktree failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not unlock — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.deleteWorktree',
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath ?? treeProvider.getSelectedPath();
        if (!target) return;
        const wt = treeProvider.getWorktree(target);
        if (!wt) {
          void vscode.window.showErrorMessage(
            'Git Workflow: worktree not found in list — refresh and try again',
          );
          return;
        }
        if (wt.isRootCheckout || wt.isMainWorktree) {
          void vscode.window.showErrorMessage(
            'Git Workflow: the main / root worktree cannot be deleted',
          );
          return;
        }

        const branchLabel =
          wt.branch + (wt.detached ? ' (detached)' : '');
        const name = path.basename(wt.path);

        // Fresh dirty probe (linked worktrees may not cache isDirty)
        let dirty = Boolean(wt.isDirty);
        // Fresh probe (git worktree remove still validates independently)
        dirty = await isWorktreeDirty(target);

        // Landed hint: merging this branch into its base changes nothing
        // (ancestry or content — same predicate as integration retirement),
        // so its COMMITS are safe. Deliberately not "nothing will be lost":
        // gitignored files in the checkout are invisible to the dirty probe.
        let landedIn: string | undefined;
        if (!wt.detached && !dirty) {
          try {
            const baseRef = await treeProvider.worktreeBaseFor(target);
            if (
              (await findLandedLanes(target, baseRef, [wt.branch])).length > 0
            ) {
              landedIn = baseRef;
            }
          } catch {
            // hint only — never block the delete flow on a probe failure
          }
        }

        // Ignored files are the one thing a delete can still destroy: the
        // dirty probe cannot see them and `git worktree remove` takes them
        // without complaint (untracked files make it refuse on their own).
        const ignored = await ignoredFiles(target);

        // Landed + clean + unlocked: every commit is already contained in
        // the base, so the confirmation has nothing to protect and the
        // removal happens on sight. Anything else — dirty, locked,
        // detached, or a checkout still holding ignored files — keeps the
        // full confirmed flow. A failed quick attempt falls through to it
        // too, so this can only ever save a click, never lose one.
        if (
          landedIn &&
          !wt.locked &&
          ignored.length === 0 &&
          isQuickDeleteLandedEnabled()
        ) {
          const quick = await removeWorktree(target, {});
          if (quick.ok) {
            log.appendLine(
              `Removed landed worktree ${target} (${wt.branch} landed in ${landedIn})`,
            );
            treeProvider.refresh();
            void vscode.window.setStatusBarMessage(
              `Git Workflow: deleted ${name} — ${wt.branch} already landed in ${landedIn}`,
              4000,
            );
            return;
          }
          log.appendLine(
            `Quick delete of landed worktree failed (${quick.code}) — falling back to confirm`,
          );
        }

        const warnings: string[] = [
          `Delete linked worktree “${name}”?`,
          '',
          `Branch: ${branchLabel}`,
          `Path: ${wt.path}`,
          '',
          'This runs `git worktree remove` and deletes the checkout folder.',
          'The branch ref is kept (not deleted).',
        ];
        if (landedIn) {
          warnings.push(
            '',
            `✓ Landed: every commit on ${wt.branch} is already contained in ${landedIn} — the checkout is safe to delete.`,
          );
        }
        if (dirty) {
          warnings.push(
            '',
            '⚠ Working tree has uncommitted changes — remove will need --force.',
          );
        }
        if (ignored.length > 0) {
          // Named explicitly: these are exactly the files the "✓ Landed"
          // line above does NOT cover.
          warnings.push(
            '',
            `⚠ ${ignored.length} ignored file(s) will be deleted with the folder (${ignored
              .slice(0, 3)
              .join(', ')}${ignored.length > 3 ? ', …' : ''}).`,
          );
        }
        if (wt.locked) {
          warnings.push(
            '',
            wt.lockReason
              ? `🔒 Locked: ${wt.lockReason}`
              : '🔒 This worktree is locked (git worktree lock).',
            'Git requires unlock or force-force (-f -f) to remove it.',
          );
        }

        const confirm = await vscode.window.showWarningMessage(
          warnings.join('\n'),
          { modal: true },
          'Delete',
          ...(wt.locked || dirty ? (['Force Delete'] as const) : []),
        );
        if (confirm !== 'Delete' && confirm !== 'Force Delete') return;

        const tryRemove = async (force: boolean, forceLocked: boolean) =>
          removeWorktree(target, { force, forceLocked });

        // Force Delete: single -f if dirty; -f -f if locked
        let result =
          confirm === 'Force Delete'
            ? await tryRemove(true, Boolean(wt.locked))
            : await tryRemove(false, false);

        // Escalate: dirty → offer force; locked → offer force-locked
        if (!result.ok && result.code === 'dirty' && confirm !== 'Force Delete') {
          const again = await vscode.window.showWarningMessage(
            `Worktree is not clean:\n${result.message}\n\nForce remove (discards uncommitted changes in this checkout)?`,
            { modal: true },
            'Force Delete',
          );
          if (again === 'Force Delete') {
            result = await tryRemove(true, false);
          } else {
            return;
          }
        }

        if (!result.ok && result.code === 'locked') {
          const again = await vscode.window.showWarningMessage(
            `Worktree is locked:\n${result.message}\n\nForce remove anyway (-f -f), or unlock first?`,
            { modal: true },
            'Force Delete',
            'Unlock Only',
          );
          if (again === 'Unlock Only') {
            try {
              await unlockWorktree(target);
              treeProvider.refresh();
              void vscode.window.showInformationMessage(
                'Git Workflow: unlocked — run Delete Worktree again to remove',
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              void vscode.window.showErrorMessage(
                `Git Workflow: unlock failed — ${message}`,
              );
            }
            return;
          }
          if (again === 'Force Delete') {
            result = await tryRemove(true, true);
          } else {
            return;
          }
        }

        if (!result.ok) {
          log.appendLine(`Delete worktree failed: ${result.message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not delete worktree — ${result.message}`,
          );
          return;
        }

        log.appendLine(`Removed worktree ${target}`);
        // If we deleted the focused worktree, selection revalidates on refresh
        treeProvider.refresh();
        void vscode.window.setStatusBarMessage(
          `Git Workflow: deleted worktree ${name}`,
          3000,
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.changeBaseRef',
      async (item?: { worktreePath?: string; baseRef?: string }) => {
        const worktreePath =
          item?.worktreePath ?? treeProvider.getSelectedPath();
        if (!worktreePath) return;
        const current =
          item?.baseRef ?? treeProvider.getBaseRef(worktreePath);
        try {
          const picked = await pickBaseRef(worktreePath, current);
          if (!picked) return;
          await treeProvider.setBaseRef(worktreePath, picked);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Change base ref failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not change base — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.copyCommitSha',
      async (item?: CommitItem) => {
        const sha = item?.commit.hash;
        if (!sha) return;
        await vscode.env.clipboard.writeText(sha);
        void vscode.window.setStatusBarMessage(
          `Git Workflow: copied ${item.commit.shortHash}`,
          2000,
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.openFileDiff',
      async (item?: FileItem) => {
        if (!item) return;
        try {
          if (item.diffKind === 'commit' && item.commitHash) {
            await openCommitFileDiff(
              item.worktreePath,
              item.commitHash,
              item.file,
            );
            return;
          }
          if (item.diffKind === 'vsBase') {
            await openWorkingTreeDiff(
              item.worktreePath,
              item.baseRef,
              item.file,
              'Working Tree',
            );
            return;
          }
          if (item.statusSide === 'staged') {
            await openStagedDiff(item.worktreePath, item.file);
            return;
          }
          await openUnstagedDiff(item.worktreePath, item.file);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Open diff failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not open diff — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.stageFile',
      async (item?: FileItem) => {
        if (!item?.file.path) return;
        try {
          const paths = [item.file.path];
          if (item.file.oldPath) paths.push(item.file.oldPath);
          await stagePaths(item.worktreePath, paths);
          treeProvider.refreshCompare(item.worktreePath);
          log.appendLine(`Staged ${item.file.path}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Stage failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not stage — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.commitStaged',
      async (item?: SectionItem | { worktreePath?: string }) => {
        const worktreePath =
          item?.worktreePath ?? treeProvider.getSelectedPath();
        if (!worktreePath) return;
        const message = await vscode.window.showInputBox({
          prompt: 'Commit message (staged files only)',
          placeHolder: 'Commit message',
          ignoreFocusOut: true,
          validateInput: (v) =>
            v.trim() ? undefined : 'Message is required',
        });
        if (message === undefined) return;
        try {
          await commitStaged(worktreePath, message);
          treeProvider.refreshCompare(worktreePath);
          log.appendLine(`Committed staged in ${worktreePath}`);
          void vscode.window.setStatusBarMessage(
            'Git Workflow: committed staged changes',
            3000,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.appendLine(`Commit staged failed: ${msg}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: commit failed — ${msg}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.commitUnstaged',
      async (item?: SectionItem | { worktreePath?: string }) => {
        const worktreePath =
          item?.worktreePath ?? treeProvider.getSelectedPath();
        if (!worktreePath) return;
        const status = await getWorkingStatus(worktreePath);
        if (status.staged.length > 0) {
          void vscode.window.showWarningMessage(
            'Git Workflow: unstage or commit staged files first — Commit Unstaged is disabled while the index has staged changes',
          );
          return;
        }
        if (status.unstaged.length === 0) {
          void vscode.window.showInformationMessage(
            'Git Workflow: nothing unstaged to commit',
          );
          return;
        }
        const message = await vscode.window.showInputBox({
          prompt:
            'Commit message (will stage all unstaged/untracked, then commit)',
          placeHolder: 'Commit message',
          ignoreFocusOut: true,
          validateInput: (v) =>
            v.trim() ? undefined : 'Message is required',
        });
        if (message === undefined) return;
        try {
          const paths = status.unstaged.flatMap((f) =>
            f.oldPath ? [f.path, f.oldPath] : [f.path],
          );
          await commitUnstagedPaths(worktreePath, paths, message);
          treeProvider.refreshCompare(worktreePath);
          log.appendLine(`Committed unstaged in ${worktreePath}`);
          void vscode.window.setStatusBarMessage(
            'Git Workflow: committed unstaged changes',
            3000,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.appendLine(`Commit unstaged failed: ${msg}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: commit failed — ${msg}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.unstageFile',
      async (item?: FileItem) => {
        if (!item?.file.path) return;
        try {
          const paths = [item.file.path];
          if (item.file.oldPath) paths.push(item.file.oldPath);
          await unstagePaths(item.worktreePath, paths);
          treeProvider.refreshCompare(item.worktreePath);
          log.appendLine(`Unstaged ${item.file.path}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Unstage failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not unstage — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand('worktreeCompare.openLogFile', async () => {
      const uri = vscode.Uri.file(log.logFile);
      await vscode.window.showTextDocument(uri);
    }),
    vscode.commands.registerCommand(
      'worktreeCompare.refreshPullRequests',
      async () => {
        treeProvider.clearPullRequestCache();
        await treeProvider.refreshPullRequests();
        void vscode.window.setStatusBarMessage(
          'Git Workflow: refreshed PR status',
          2000,
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.openPullRequest',
      async (item?: {
        worktreePath?: string;
        pullRequest?: { url?: string };
        pr?: { url?: string };
      }) => {
        const pr =
          item?.pullRequest ??
          item?.pr ??
          (item?.worktreePath
            ? treeProvider.getPullRequest(item.worktreePath)
            : undefined);
        const url = pr?.url;
        if (!url) {
          void vscode.window.showInformationMessage(
            'Git Workflow: no pull request linked',
          );
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.copyPullRequestUrl',
      async (item?: {
        worktreePath?: string;
        pullRequest?: { url?: string };
        pr?: { url?: string };
      }) => {
        const pr =
          item?.pullRequest ??
          item?.pr ??
          (item?.worktreePath
            ? treeProvider.getPullRequest(item.worktreePath)
            : undefined);
        const url = pr?.url;
        if (!url) {
          void vscode.window.showInformationMessage(
            'Git Workflow: no pull request linked',
          );
          return;
        }
        await vscode.env.clipboard.writeText(url);
        void vscode.window.setStatusBarMessage(
          `Git Workflow: copied PR URL`,
          2000,
        );
      },
    ),
  ];
}
