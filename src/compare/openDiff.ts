import * as path from 'node:path';
import * as vscode from 'vscode';
import { toGitContentUri } from '../git/contentProvider';
import type { FileChange } from '../git/compare';

/** The real file on disk — the only editable side a diff can have. */
function worktreeFile(worktreePath: string, relativePath: string): vscode.Uri {
  return vscode.Uri.file(path.join(worktreePath, ...relativePath.split('/')));
}

interface DiffSides {
  left: vscode.Uri;
  right: vscode.Uri;
  title: string;
  /**
   * Where a file that exists on one side only opens instead of as a diff.
   *
   * A whole-file diff is a wall of green or red that says nothing the file
   * itself does not say better, so an added file opens as `added` and a
   * deleted one as `deleted` — whichever side actually has content. Omit
   * either to diff anyway: between two commits both sides are virtual and
   * the empty half is the honest answer.
   */
  added?: vscode.Uri;
  deleted?: vscode.Uri;
}

async function openSides(file: FileChange, sides: DiffSides): Promise<void> {
  const { left, right, title, added, deleted } = sides;
  const oneSided =
    file.status === 'D'
      ? deleted
      : file.status === 'A' || file.status === '?'
        ? added
        : undefined;

  if (oneSided) {
    await vscode.commands.executeCommand('vscode.open', oneSided);
    return;
  }

  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}

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
  const right = worktreeFile(worktreePath, file.path);
  const left = toGitContentUri(worktreePath, leftRef, file.oldPath ?? file.path);
  await openSides(file, {
    left,
    right,
    title: `${path.basename(file.path)} (${leftRef} ↔ ${titleRightLabel})`,
    added: right,
    deleted: left,
  });
}

/**
 * Unstaged only: Index ↔ Working Tree (real file on the right).
 * Does not mix in staged-only hunks.
 */
export async function openUnstagedDiff(
  worktreePath: string,
  file: FileChange,
): Promise<void> {
  const right = worktreeFile(worktreePath, file.path);
  const left = toGitContentUri(worktreePath, 'INDEX', file.oldPath ?? file.path);
  await openSides(file, {
    left,
    right,
    title: `${path.basename(file.path)} (Index ↔ Working Tree)`,
    added: right,
    deleted: left,
  });
}

/**
 * Staged only: HEAD ↔ Index (both virtual — no unstaged WT noise).
 * Added files open the real worktree path for editing.
 */
export async function openStagedDiff(
  worktreePath: string,
  file: FileChange,
): Promise<void> {
  const left = toGitContentUri(worktreePath, 'HEAD', file.oldPath ?? file.path);
  await openSides(file, {
    left,
    right: toGitContentUri(worktreePath, 'INDEX', file.path),
    title: `${path.basename(file.path)} (HEAD ↔ Index)`,
    added: worktreeFile(worktreePath, file.path),
    deleted: left,
  });
}

/** One commit against its parent — both sides virtual, both sides read-only. */
export async function openCommitFileDiff(
  worktreePath: string,
  commitHash: string,
  file: FileChange,
): Promise<void> {
  await openSides(file, {
    left: toGitContentUri(
      worktreePath,
      `${commitHash}^`,
      file.oldPath ?? file.path,
    ),
    right: toGitContentUri(worktreePath, commitHash, file.path),
    title: `${path.basename(file.path)} (${commitHash.slice(0, 7)})`,
  });
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
  const left = toGitContentUri(repoCwd, baseRef, file.oldPath ?? file.path);
  const right = toGitContentUri(repoCwd, headRef, file.path);
  const suffix = titleSuffix ? ` · ${titleSuffix}` : '';
  await openSides(file, {
    left,
    right,
    title: `${path.basename(file.path)} (${baseRef} ↔ ${headRef})${suffix}`,
    // A new file stays virtual here: there is no checkout to edit
    added: right,
    deleted: left,
  });
}
