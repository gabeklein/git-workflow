import * as vscode from 'vscode';
import type { TreeNode } from './nodes';
import { IntegrationLaneItem } from './nodes/lanes';

/**
 * Dragging lane rows to say which lane wins.
 *
 * Merge order decides conflict outcomes — union inserts land in merge
 * order, and best-effort resolves same-line clashes toward the incoming
 * lane. Since #35 that order is the order lanes were included, which is
 * meaningful but not always what you want; this is the direct way to say
 * otherwise, and it is the reason DND is worth having at all. Before order
 * was user-defined there was nothing for a drag to mean.
 *
 * Only APPLIED lanes reorder. An unchecked candidate is not in the merge
 * chain, so a position for it would be a position in nothing.
 */

/**
 * Within-tree drags carry the VIEW ID, lowercased, by VS Code convention —
 * so this has to track the view the lanes are actually rendered in. It said
 * `...integration` until that panel became the Preview group of Lanes; a
 * stale value here does not fail loudly, it just means nothing can be
 * dropped.
 */
const MIME = 'application/vnd.code.tree.worktreecomparelanes';

export class LaneDragAndDropController
  implements vscode.TreeDragAndDropController<TreeNode>
{
  readonly dropMimeTypes = [MIME];
  readonly dragMimeTypes = [MIME];

  constructor(
    private readonly reorder: (
      lane: string,
      before: string | undefined,
    ) => Promise<void>,
  ) {}

  handleDrag(
    source: readonly TreeNode[],
    data: vscode.DataTransfer,
  ): void {
    const lanes = source
      .filter(
        (n): n is IntegrationLaneItem =>
          n instanceof IntegrationLaneItem && n.applied,
      )
      .map((n) => n.branch);
    if (lanes.length === 0) return;
    data.set(MIME, new vscode.DataTransferItem(lanes));
  }

  async handleDrop(
    target: TreeNode | undefined,
    data: vscode.DataTransfer,
  ): Promise<void> {
    const item = data.get(MIME);
    if (!item) return;
    // The payload survives a round trip through the host, so it may arrive
    // as JSON rather than the array that was set.
    let lanes: string[];
    const value: unknown = item.value;
    if (Array.isArray(value)) {
      lanes = value.filter((v): v is string => typeof v === 'string');
    } else {
      try {
        const parsed: unknown = JSON.parse(String(value));
        lanes = Array.isArray(parsed)
          ? parsed.filter((v): v is string => typeof v === 'string')
          : [];
      } catch {
        return;
      }
    }
    if (lanes.length === 0) return;
    // Dropped on a lane → land before it. Dropped on empty space or on any
    // other row → last, which is the only unambiguous reading.
    const before =
      target instanceof IntegrationLaneItem && target.applied
        ? target.branch
        : undefined;
    for (const lane of lanes) {
      if (lane === before) continue;
      await this.reorder(lane, before);
    }
  }
}
