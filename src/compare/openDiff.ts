import * as path from 'node:path';
import * as vscode from 'vscode';
import { toGitContentUri } from '../git/contentProvider';
import type { FileChange } from '../git/compare';

export async function openWorkingTreeDiff(
  worktreePath: string,
  baseRef: string,
  file: FileChange,
): Promise<void> {
  const rel = file.path;
  const abs = path.join(worktreePath, ...rel.split('/'));
  const right = vscode.Uri.file(abs); // real file — edits land on disk
  const left = toGitContentUri(worktreePath, baseRef, rel);

  const title = `${path.basename(rel)} (${baseRef} ↔ Working Tree)`;

  if (file.status === 'A') {
    // Added in working tree — nothing on base; still open diff with empty left
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
    return;
  }

  if (file.status === 'D') {
    // Deleted in working tree — show base only (left), no real file to edit
    await vscode.commands.executeCommand('vscode.open', left);
    return;
  }

  await vscode.commands.executeCommand('vscode.diff', left, right, title);
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
