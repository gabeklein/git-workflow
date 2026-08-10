import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  openCommitFileDiff,
  openRemotePrFileDiff,
  openStagedDiff,
  openUnstagedDiff,
  openWorkingTreeDiff,
} from './compare/openDiff';
import { pickBaseRef } from './compare/pickBaseRef';
import { pickWorktree } from './compare/pickWorktree';
import { GitContentProvider, GIT_CONTENT_SCHEME } from './git/contentProvider';
import { stagePaths, unstagePaths } from './git/stage';
import { git } from './git/exec';
import {
  removeWorktree,
  unlockWorktree,
} from './git/worktreeAdmin';
import {
  createWorktreeForPr,
  defaultPrWorktreePath,
  type RemotePullRequest,
} from './github/remotePrs';
import { createFileBackedLogger } from './log';
import {
  CommitItem,
  FileItem,
  RemotePrFileItem,
  RemotePrItem,
  WorktreeTreeProvider,
} from './views/worktreeTree';

export function activate(context: vscode.ExtensionContext): void {
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
        if (!path) {
          return;
        }
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
        if (!picked) {
          return;
        }
        await treeProvider.setSelectedPath(picked.path);
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.openWorktree',
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath ?? treeProvider.getSelectedPath();
        if (!target) {
          return;
        }
        await vscode.commands.executeCommand(
          'revealInExplorer',
          vscode.Uri.file(target),
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.unlockWorktree',
      async (item?: { worktreePath?: string }) => {
        const target = item?.worktreePath ?? treeProvider.getSelectedPath();
        if (!target) {
          return;
        }
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
        if (!target) {
          return;
        }
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
        try {
          const porcelain = await git(target, [
            'status',
            '--porcelain=v1',
            '-unormal',
            '--ignore-submodules=dirty',
          ]);
          dirty = porcelain.trim().length > 0;
        } catch {
          // ignore probe failure; git remove will still validate
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
        if (dirty) {
          warnings.push(
            '',
            '⚠ Working tree has uncommitted changes — remove will need --force.',
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
        if (confirm !== 'Delete' && confirm !== 'Force Delete') {
          return;
        }

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
        if (!worktreePath) {
          return;
        }
        const current =
          item?.baseRef ?? treeProvider.getBaseRef(worktreePath);
        try {
          const picked = await pickBaseRef(worktreePath, current);
          if (!picked) {
            return;
          }
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
        if (!sha) {
          return;
        }
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
        if (!item) {
          return;
        }
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
        if (!item?.file.path) {
          return;
        }
        try {
          const paths = [item.file.path];
          if (item.file.oldPath) {
            paths.push(item.file.oldPath);
          }
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
      'worktreeCompare.unstageFile',
      async (item?: FileItem) => {
        if (!item?.file.path) {
          return;
        }
        try {
          const paths = [item.file.path];
          if (item.file.oldPath) {
            paths.push(item.file.oldPath);
          }
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
        await Promise.all([
          treeProvider.refreshPullRequests(),
          treeProvider.refreshRemotePrs(),
        ]);
        void vscode.window.setStatusBarMessage(
          'Git Workflow: refreshed PR status',
          2000,
        );
      },
    ),
    vscode.commands.registerCommand(
      'worktreeCompare.refreshRemotePrs',
      async () => {
        await treeProvider.refreshRemotePrs();
        void vscode.window.setStatusBarMessage(
          'Git Workflow: refreshed remote PRs',
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
      'worktreeCompare.createWorktreeFromPr',
      async (item?: RemotePrItem | { pr?: RemotePullRequest; repoCwd?: string }) => {
        const pr = item && 'pr' in item ? item.pr : undefined;
        const repoCwd =
          item && 'repoCwd' in item && item.repoCwd
            ? item.repoCwd
            : treeProvider.getRepoCwd();
        if (!pr || !repoCwd) {
          void vscode.window.showInformationMessage(
            'Git Workflow: pick a Remote PR first',
          );
          return;
        }
        if (pr.hasLocalWorktree) {
          void vscode.window.showInformationMessage(
            `Git Workflow: a local worktree already uses branch ${pr.headRefName}`,
          );
          return;
        }

        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? repoCwd;
        const suggested = defaultPrWorktreePath(workspaceRoot, pr);
        const dest = await vscode.window.showInputBox({
          prompt: `Create worktree for PR #${pr.number} (${pr.headRefName || 'detached head'})`,
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
              title: `Git Workflow: creating worktree for PR #${pr.number}…`,
            },
            async () => {
              const created = await createWorktreeForPr(
                repoCwd,
                pr,
                dest.trim(),
              );
              log.appendLine(
                `Created worktree for PR #${pr.number} at ${created}`,
              );
              treeProvider.refresh();
              await treeProvider.setSelectedPath(created);
              void vscode.window.showInformationMessage(
                `Git Workflow: worktree ready at ${created}`,
              );
            },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.appendLine(`Create worktree from PR failed: ${message}`);
          void vscode.window.showErrorMessage(
            `Git Workflow: could not create worktree — ${message}`,
          );
        }
      },
    ),
  );
}

export function deactivate(): void {
  // nothing yet
}
