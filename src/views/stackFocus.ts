import * as vscode from 'vscode';
import { buildCombined, COMBINED_REF } from '../git/combined';
import type { TreeNode } from './nodes';
import type { StackRowInfo } from './nodes/stacks';
import type { LanesTreeProvider } from './lanesTree';
import { lanesLayout } from './lanesLayout';
import type { WorktreeTreeProvider } from './worktreeTree';

/**
 * Under the stacks layout, SELECTION in Lanes is what Focus shows:
 *
 *   a branch    its commits and diff against its parent (its checkout,
 *               when it has one)
 *   the trunk   its history, to browse
 *   the preview what the last rebuild produced
 *   several     those branches merged together, against their merge-base
 *
 * Selection rather than row commands, because a command fires on every
 * click — including the shift-click that extends a selection — and would
 * race the combined focus it is part of.
 */
export function registerStackFocus(
  treeView: vscode.TreeView<TreeNode>,
  worktrees: WorktreeTreeProvider,
  lanes: LanesTreeProvider,
  log: { appendLine(value: string): void },
): vscode.Disposable[] {
  const focus = async (selection: readonly TreeNode[]) => {
    const cwd = worktrees.getRepoCwd();
    if (!cwd) return;
    const stacked = selection
      .map((n) => (n as { stack?: StackRowInfo }).stack)
      .filter((s): s is StackRowInfo => Boolean(s));

    if (stacked.length >= 2) {
      const names = stacked.map((s) => s.branch);
      const combined = await vscode.window.withProgress(
        { location: { viewId: 'worktreeCompare.focused' } },
        () => buildCombined(cwd, stacked.map((s) => s.ref)),
      );
      log.appendLine(
        `Combined ${names.join(' + ')} → ${combined.sha.slice(0, 7)} (${combined.conflicts.length} conflict(s))`,
      );
      await worktrees.focusRef({
        ref: COMBINED_REF,
        branch: names.join(' + '),
        source: 'local',
        base: combined.base,
        label: `${names.length} combined`,
        conflicts: combined.conflicts,
        parts: stacked.map((s) => s.ref),
      });
      return;
    }
    if (selection.length !== 1) return;
    const node = selection[0];
    const stack = stacked[0];
    if (stack) {
      if (stack.worktreePath) {
        await worktrees.setSelectedPath(stack.worktreePath);
        return;
      }
      await worktrees.focusRef({
        ref: stack.ref,
        branch: stack.branch,
        source: stack.ref.startsWith('origin/') ? 'remote' : 'local',
        base: stack.base,
        label: `${stack.branch} → ${stack.base.replace(/^origin\//, '')}`,
      });
      return;
    }
    switch (node.kind) {
      case 'trunk':
        await worktrees.focusRef({
          ref: node.ref,
          branch: node.ref,
          source: 'remote',
          label: `${node.ref} history`,
          history: true,
        });
        return;
      case 'preview': {
        const preview = worktrees.getPreview();
        if (!preview) return;
        await worktrees.focusRef({
          ref: preview.branch,
          branch: preview.branch,
          source: 'local',
          base: await lanes.trunk(cwd),
          label: 'Preview',
        });
        return;
      }
      // Anything else (a Landed row) keeps its own click command.
    }
  };

  return [
    treeView.onDidChangeSelection(async (e) => {
      if (lanesLayout() !== 'stacks') return;
      try {
        await focus(e.selection);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.appendLine(`Focus from selection failed: ${message}`);
        void vscode.window.showErrorMessage(`Git Workflow: could not focus — ${message}`);
      }
    }),
    vscode.commands.registerCommand('worktreeCompare.loadMoreTrunk', () =>
      worktrees.loadMoreHistory(),
    ),
    // Pins keep a branch at the top however long it sits idle.
    vscode.commands.registerCommand('worktreeCompare.pinBranch', (item?: TreeNode) =>
      pin(item, true),
    ),
    vscode.commands.registerCommand('worktreeCompare.unpinBranch', (item?: TreeNode) =>
      pin(item, false),
    ),
    vscode.commands.registerCommand('worktreeCompare.filterLanes', async () => {
      const stacks = lanes.getStacks();
      const text = await vscode.window.showInputBox({
        title: 'Filter Lanes',
        prompt: 'Show branches whose name contains this — older ones included',
        value: stacks.getFilter(),
      });
      if (text === undefined) return;
      setFilter(text);
    }),
    vscode.commands.registerCommand('worktreeCompare.clearLanesFilter', () =>
      setFilter(''),
    ),
  ];

  async function pin(item: TreeNode | undefined, on: boolean) {
    const targets = [
      ...new Set([item, ...treeView.selection].filter((n): n is TreeNode => Boolean(n))),
    ]
      .map((n) => (n as { stack?: StackRowInfo }).stack?.branch)
      .filter((b): b is string => Boolean(b));
    // The clicked row, or every selected one when it is part of a selection
    const branches = item && !treeView.selection.includes(item)
      ? targets.slice(0, 1)
      : targets;
    for (const b of branches) await lanes.getStacks().setPinned(b, on);
    lanes.refresh();
  }

  function setFilter(text: string) {
    const stacks = lanes.getStacks();
    stacks.setFilter(text);
    const active = stacks.getFilter();
    treeView.message = active ? `Filtered by “${active}”` : undefined;
    void vscode.commands.executeCommand('setContext', 'worktreeCompare.lanesFiltered', Boolean(active));
    lanes.refresh();
  }
}
