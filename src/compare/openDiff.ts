import * as path from 'node:path';
import * as vscode from 'vscode';
import { toGitContentUri } from '../git/contentProvider';
import type { FileChange } from '../git/compare';

/**
 * Editable diff: left = ref content, right = real worktree file.
 * Used for Full Diff (Working Tree ↔ base).
 *
 * Added / untracked files open for edit (no full-file green wall). Further
 * edits still pick up built-in Git gutter decorations on tracked files.
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
  const left = toGitContentUri(worktreePath, leftRef, file.oldPath ?? rel);
  const title = `${path.basename(rel)} (${leftRef} ↔ ${titleRightLabel})`;

  if (file.status === 'A' || file.status === '?') {
    await openWorkingTreeFile(worktreePath, file);
    return;
  }

  if (file.status === 'D') {
    await vscode.commands.executeCommand('vscode.open', left);
    return;
  }

  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}

/**
 * Unstaged only: Index ↔ Working Tree (real file on the right).
 * Does not mix in staged-only hunks.
 */
export async function openUnstagedDiff(
  worktreePath: string,
  file: FileChange,
): Promise<void> {
  const rel = file.path;
  const abs = path.join(worktreePath, ...rel.split('/'));
  const right = vscode.Uri.file(abs);
  const left = toGitContentUri(worktreePath, 'INDEX', file.oldPath ?? rel);
  const title = `${path.basename(rel)} (Index ↔ Working Tree)`;

  if (file.status === 'A' || file.status === '?') {
    await openWorkingTreeFile(worktreePath, file);
    return;
  }

  if (file.status === 'D') {
    await vscode.commands.executeCommand('vscode.open', left);
    return;
  }

  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}

/**
 * Staged only: HEAD ↔ Index (both virtual — no unstaged WT noise).
 * Added files open the real worktree path for editing.
 */
export async function openStagedDiff(
  worktreePath: string,
  file: FileChange,
): Promise<void> {
  const rel = file.path;
  const left = toGitContentUri(worktreePath, 'HEAD', file.oldPath ?? rel);
  const right = toGitContentUri(worktreePath, 'INDEX', rel);
  const title = `${path.basename(rel)} (HEAD ↔ Index)`;

  if (file.status === 'A') {
    await openWorkingTreeFile(worktreePath, file);
    return;
  }

  if (file.status === 'D') {
    await vscode.commands.executeCommand('vscode.open', left);
    return;
  }

  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}

/** Open the real file only (fallback for awkward statuses). */
async function openWorkingTreeFile(
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

/**
 * Fully virtual, read-only PR review diff (no worktree checkout).
 * Both sides use the content provider.
 */
export async function openRemotePrFileDiff(
  repoCwd: string,
  baseRef: string,
  headRef: string,
  file: FileChange,
  titleSuffix?: string,
): Promise<void> {
  const rel = file.path;
  const left = toGitContentUri(repoCwd, baseRef, file.oldPath ?? rel);
  const right = toGitContentUri(repoCwd, headRef, rel);
  const suffix = titleSuffix ? ` · ${titleSuffix}` : '';
  const title = `${path.basename(rel)} (${baseRef} ↔ ${headRef})${suffix}`;

  if (file.status === 'D') {
    await vscode.commands.executeCommand('vscode.open', left);
    return;
  }
  if (file.status === 'A' || file.status === '?') {
    // Still a virtual "new file" view (read-only), not the full green wall of WT
    await vscode.commands.executeCommand('vscode.open', right);
    return;
  }
  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}
