import * as vscode from 'vscode';

/**
 * How Lanes is laid out. `stacks` lists branches leading into the trunk,
 * stacked on their parents, with a checkout as a badge; `groups` is the
 * older ladder of Working / Local / Remote / Landed, where a checkout is
 * what a row stands for.
 *
 * Focus follows it: under `stacks` a branch's commits are already rows in
 * Lanes, so Focus stops repeating them.
 */
export function lanesLayout(): 'stacks' | 'groups' {
  return vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<string>('lanesLayout', 'stacks') === 'groups'
    ? 'groups'
    : 'stacks';
}
