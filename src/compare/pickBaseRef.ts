import * as vscode from 'vscode';
import { listCompareRefs, type GitRef, type RefKind } from '../git/refs';

interface RefQuickPickItem extends vscode.QuickPickItem {
  refName?: string;
}

function iconFor(kind: RefKind): vscode.ThemeIcon {
  switch (kind) {
    case 'head':
      return new vscode.ThemeIcon('target');
    case 'remote':
      return new vscode.ThemeIcon('cloud');
    case 'tag':
      return new vscode.ThemeIcon('tag');
    default:
      return new vscode.ThemeIcon('git-branch');
  }
}

function toItems(refs: GitRef[], currentBase?: string): RefQuickPickItem[] {
  const items: RefQuickPickItem[] = [];

  const pushGroup = (label: string, kind: RefKind) => {
    const group = refs.filter((r) => r.kind === kind);
    if (group.length === 0 && kind !== 'head') return;
    items.push({
      label,
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const ref of group.length ? group : refs.filter((r) => r.kind === kind)) {
      const descriptionParts = [
        ref.shortHash,
        ref.relativeDate,
        currentBase === ref.name ? 'current base' : undefined,
      ].filter(Boolean);
      items.push({
        label: ref.name,
        description: descriptionParts.join(' · '),
        iconPath: iconFor(ref.kind),
        refName: ref.name,
      });
    }
  };

  // HEAD first without a noisy separator when alone
  const head = refs.find((r) => r.kind === 'head');
  if (head) {
    items.push({
      label: head.name,
      description: currentBase === head.name ? 'current base' : undefined,
      iconPath: iconFor('head'),
      refName: head.name,
    });
  }

  pushGroup('branches', 'local');
  pushGroup('remote branches', 'remote');
  pushGroup('tags', 'tag');

  return items;
}

/**
 * GitLens-style "Choose a reference" picker. Returns the selected ref name, or undefined if cancelled.
 * Free-typed values are accepted when they don't match a listed item.
 */
export async function pickBaseRef(
  worktreePath: string,
  currentBase?: string,
): Promise<string | undefined> {
  const refs = await listCompareRefs(worktreePath);
  const items = toItems(refs, currentBase);

  const qp = vscode.window.createQuickPick<RefQuickPickItem>();
  qp.title = 'Compare';
  qp.placeholder =
    'Choose a reference (branch, tag, etc.) to compare (or type a revision)';
  qp.matchOnDescription = true;
  qp.items = items;
  qp.value = '';
  if (currentBase) {
    const active = items.find((i) => i.refName === currentBase);
    if (active) qp.activeItems = [active];
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      qp.hide();
      qp.dispose();
      resolve(value);
    };

    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      if (selected?.refName) {
        finish(selected.refName);
        return;
      }
      const typed = qp.value.trim();
      finish(typed || undefined);
    });

    qp.onDidHide(() => {
      finish(undefined);
    });

    qp.show();
  });
}
