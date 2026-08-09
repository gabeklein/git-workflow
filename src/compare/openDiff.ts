import * as path from 'node:path';
import * as vscode from 'vscode';
import { toGitContentUri } from '../git/contentProvider';
import type { FileChange } from '../git/compare';

/**
 * Editable diff: left = ref content, right = real worktree file.
 * Used for Squash (vs base) and dirty Changes (vs HEAD).
 */
export async function openWorkingTreeDiff(
  worktreePath: string,
  leftRef: string,
  file: FileChange,
  titleRightLabel = 'Working Tree',
): Promise<void> {
  const rel = file.path;
  const abs = path.join(worktreePath, ...rel.split('/'));
  const right = vscode.Uri.file(abs);
  const left = toGitContentUri(worktreePath, leftRef, rel);

  const title = `${path.basename(rel)} (${leftRef} ↔ ${titleRightLabel})`;

  if (file.status === 'A' || file.status === '?') {
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
    return;
  }

  if (file.status === 'D') {
    await vscode.commands.executeCommand('vscode.open', left);
    return;
  }

  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}

/** Open the real file only (fallback for awkward statuses). */
export async function openWorkingTreeFile(
  worktreePath: string,
  file: FileChange,
): Promise<void> {
  const abs = path.join(worktreePath, ...file.path.split('/'));
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs));
}

export async function openCommitFileDiff(
  worktreePath: string,
  commitHash: string,
  file: FileChange,
): Promise<void> {
  const rel = file.path;
  const parent = `${commitHash}^`;
  const left = toGitContentUri(worktreePath, parent, file.oldPath ?? rel);
  const right = toGitContentUri(worktreePath, commitHash, rel);
  const title = `${path.basename(rel)} (${commitHash.slice(0, 7)})`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}
