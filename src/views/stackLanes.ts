import * as path from 'node:path';
import * as vscode from 'vscode';
import { git } from '../git/exec';
import { isWorktreeDirty } from '../git/plumbing';
import { previewBaseRef } from '../git/preview';
import {
  arrangeStacks,
  layoutStack,
  planStacks,
  readStackRefs,
  type StackCommit,
  type StackNode,
  type StackPr,
} from '../git/stacks';
import { createGhJson } from '../github/gh';
import { MessageItem, type TreeNode } from './nodes';
import { BranchItem } from './nodes/branches';
import {
  StackGroupItem,
  TrunkItem,
  type StackRowInfo,
} from './nodes/stacks';
import type { BranchesTreeProvider } from './branchesTree';
import type { WorktreeTreeProvider } from './worktreeTree';

/**
 * The stacks layout of Lanes: branches leading into the trunk, each
 * stacked on its parent, with a checkout as a badge on its branch rather
 * than the thing the row stands for.
 *
 * Rows are FLAT, not nested: a stacked branch is listed right after its
 * parent with a glyph in front (layoutStack): siblings — several branches
 * on one parent — step in with `├` `└`, and a linear stack stays at one
 * indent with `↳`, each branch on the one above. Every row is a leaf —
 * selecting one is how you look inside it, in Focus — so the list stays
 * a list.
 *
 * Ordered by what you are working on (arrangeStacks): pinned stacks, then
 * live ones most recent first, then the folded Older and Remote groups.
 */

/** Row decoration for the stacks layout's branch rows. */
type StackRow = TreeNode & { stack?: StackRowInfo };


/** A detached checkout's pseudo-branch name. */
const DETACHED = '⌀ ';

const PINS_KEY = 'worktreeCompare.pinnedBranches';

export class StackLanes {
  private login: Promise<string | undefined> | undefined;
  private readonly gh = createGhJson();
  /** Rows of the folded groups (Older, Remote), from the last render. */
  private readonly groupRows = new Map<string, TreeNode[]>();
  private filter = '';

  constructor(
    private readonly worktrees: WorktreeTreeProvider,
    private readonly branches: BranchesTreeProvider,
    /** Workspace state: pins are per repo. */
    private readonly state: vscode.Memento,
  ) {}

  /** Pinned branch names, in the order they were pinned. */
  pinned(): string[] {
    return this.state.get<string[]>(PINS_KEY, []);
  }

  async setPinned(branch: string, on: boolean): Promise<void> {
    const rest = this.pinned().filter((b) => b !== branch);
    await this.state.update(PINS_KEY, on ? [...rest, branch] : rest);
  }

  getFilter(): string {
    return this.filter;
  }

  setFilter(text: string): void {
    this.filter = text.trim();
  }


  /** The ref everything leads into: origin's copy of the preview base. */
  async trunk(cwd: string): Promise<string> {
    const base = previewBaseRef();
    if (base.startsWith('origin/')) return base;
    const remote = `origin/${base}`;
    try {
      await git(cwd, ['rev-parse', '--verify', '--quiet', `${remote}^{commit}`]);
      return remote;
    } catch {
      return base;
    }
  }

  async rows(cwd: string, previewRow: TreeNode): Promise<TreeNode[]> {
    const trunk = await this.trunk(cwd);
    const preview = this.worktrees.getPreview();
    const checkouts = this.worktrees
      .getWorktrees()
      .filter((w) => w.path !== preview?.path);

    // Detached checkouts are work with no branch — they get a row too.
    const detached = await Promise.all(
      checkouts
        .filter((w) => w.detached)
        .map(async (w) => ({
          wt: w,
          tip: (await git(w.path, ['rev-parse', 'HEAD'])).trim(),
        })),
    );
    const refs = await readStackRefs(cwd, trunk, detached.map((d) => d.tip));
    for (const d of detached) {
      refs.branches.push({
        name: `${DETACHED}${path.basename(d.wt.path)}`,
        tip: d.tip,
        date: Date.now() / 1000,
        local: true,
        remote: false,
      });
    }

    const prs = new Map<string, StackPr>();
    for (const b of refs.branches) {
      const pr = this.branches.getPullRequestFor(b.name);
      if (pr) prs.set(b.name, { number: pr.number, base: pr.baseRefName, authorLogin: pr.authorLogin });
    }
    const [recorded, emails, login] = await Promise.all([
      recordedBases(cwd),
      authorEmails(cwd),
      this.myLogin(cwd),
    ]);
    const plan = planStacks({
      trunk,
      branches: refs.branches,
      graph: refs.graph,
      prs,
      recorded,
      landed: this.branches.getLanded(),
      me: { emails, login },
    });

    const byBranch = new Map(
      checkouts.filter((w) => !w.detached).map((w) => [w.branch, w] as const),
    );
    for (const d of detached) byBranch.set(`${DETACHED}${path.basename(d.wt.path)}`, d.wt);
    const dirty = new Map(
      await Promise.all(
        [...byBranch.entries()].map(
          async ([b, w]) => [b, await isWorktreeDirty(w.path).catch(() => false)] as const,
        ),
      ),
    );

    // The local trunk is hidden while it matches origin's — unless it is a
    // checkout with uncommitted work, which is exactly what must not hide.
    const trunkShort = trunk.replace(/^origin\//, '');
    if (dirty.get(trunkShort) && !plan.roots.some((n) => n.name === trunkShort)) {
      plan.roots.unshift({
        name: trunkShort,
        via: 'trunk',
        commits: [],
        children: [],
        local: true,
        remote: false,
      });
    }

    const all: StackNode[] = [];
    const collect = (n: StackNode) => {
      all.push(n);
      n.children.forEach(collect);
    };
    plan.roots.forEach(collect);
    const behind = await behindTrunk(cwd, trunk, plan.roots);
    const info = new Map(refs.branches.map((b) => [b.name, b]));
    const sync = new Map(this.branches.getBranches().map((b) => [b.name, b]));
    const pins = this.pinned();

    const build = (node: StackNode, glyph: string): StackRow => {
      const b = info.get(node.name);
      const wt = byBranch.get(node.name);
      const isDetached = node.name.startsWith(DETACHED);
      const ref = isDetached
        ? (b?.tip ?? node.name)
        : node.local
          ? node.name
          : `origin/${node.name}`;
      const parent = node.parent ? info.get(node.parent) : undefined;
      const base = parent ? (parent.local ? parent.name : `origin/${parent.name}`) : trunk;
      const commits = node.commits
        .map((sha) => refs.commits.get(sha))
        .filter((c): c is StackCommit => Boolean(c));
      const pr = isDetached ? undefined : this.branches.getPullRequestFor(node.name);
      const checkable = Boolean(preview) && node.local && !isDetached && node.name !== trunkShort;
      const pinned = pins.includes(node.name);

      let row: StackRow;
      if (wt) {
        row = this.worktrees.buildCheckoutRow(wt) as StackRow;
      } else {
        row = new BranchItem(cwd, node.name, node.local, node.remote, '', undefined, pr) as StackRow;
      }
      row.stack = { branch: node.name, ref, base, worktreePath: wt?.path, commits, checkable };
      row.label = `${glyph}${node.name}`;
      row.contextValue = `${row.contextValue ?? ''}${pinned ? 'StackPinned' : 'StackUnpinned'}`;
      // A leaf: selecting it shows its commits and files in Focus.
      row.collapsibleState = vscode.TreeItemCollapsibleState.None;
      // Selection drives Focus here (so shift-select can combine); a
      // command would fire on every click and race it.
      row.command = undefined;
      // A stable id keeps a row's expansion across refreshes.
      row.id = `stack:${node.name}`;

      const bits: string[] = [];
      if (pinned) bits.push('📌');
      if (pr) bits.push(`#${pr.number}${pr.isDraft ? ' draft' : ''}`);
      if (dirty.get(node.name)) bits.push('●');
      // Counts live in the tooltip: on the row they were noise next to the PR.
      const unpushed = sync.get(node.name)?.ahead;
      const lag = behind.get(node.name);
      if (node.restack) bits.push('⚠ restack');
      row.description = bits.join(' ');

      // Not `folder`: with a resourceUri set, that one is drawn from the
      // file-icon theme, which has nothing for these rows.
      row.iconPath = wt
        ? new vscode.ThemeIcon(
            isDetached ? 'debug-disconnect' : 'repo',
            dirty.get(node.name) ? new vscode.ThemeColor('charts.yellow') : new vscode.ThemeColor('charts.blue'),
          )
        : !node.local
          ? new vscode.ThemeIcon('cloud')
          : new vscode.ThemeIcon('git-branch');

      row.tooltip = [
        node.name,
        node.parent ? `Stacked on ${node.parent} (${viaText(node.via)})` : `Leads into ${trunk} (${viaText(node.via)})`,
        `${commits.length} commit(s) of its own`,
        wt ? `Checkout: ${wt.path}${dirty.get(node.name) ? ' — uncommitted changes' : ''}` : undefined,
        !node.local ? 'Only on the remote' : undefined,
        pr ? `PR #${pr.number}: ${pr.title}` : undefined,
        unpushed ? `${unpushed} commit(s) not pushed to its upstream` : undefined,
        lag ? `${lag} commit(s) behind ${trunk}` : undefined,
        node.restack
          ? `${node.restack} has landed, but this branch still carries its commits. Rebase with --onto to replay only its own.`
          : undefined,
        pinned ? 'Pinned' : undefined,
        'Select to focus it · shift-select several to see them combined',
      ]
        .filter(Boolean)
        .join('\n');

      row.checkboxState = checkable
        ? preview!.lanes.includes(node.name)
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked
        : undefined;
      return row;
    };

    // Siblings step in with ├ └; a linear stack stays put with ↳.
    const stackRows = (roots: StackNode[]): TreeNode[] =>
      roots.flatMap((root) => layoutStack(root).map((l) => build(l.node, l.prefix)));

    const rows: TreeNode[] = [previewRow, new TrunkItem(cwd, trunk)];

    // A filter flattens everything, older work included, newest first.
    if (this.filter) {
      const needle = this.filter.toLowerCase();
      const hits = all
        .filter((n) => n.name.toLowerCase().includes(needle))
        .sort((a, b) => (info.get(b.name)?.date ?? 0) - (info.get(a.name)?.date ?? 0));
      rows.push(...hits.map((n) => build(n, '')));
      if (!hits.length) rows.push(new MessageItem(`No branch matches “${this.filter}”`));
      return rows;
    }

    const days = vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<number>('activeDays', 14);
    const arranged = arrangeStacks(plan.roots, {
      date: (n) => info.get(n)?.date ?? 0,
      pinned: pins,
      // Age says nothing about a checkout left open, a preview lane, or
      // unpushed work on the local trunk.
      keep: (n) =>
        byBranch.has(n) || Boolean(preview?.lanes.includes(n)) || n === trunkShort,
      since: Date.now() / 1000 - days * 86_400,
    });
    rows.push(...stackRows(arranged.pinned), ...stackRows(arranged.active));
    this.groupRows.clear();
    if (arranged.older.length) {
      this.groupRows.set('Older', stackRows(arranged.older));
      rows.push(new StackGroupItem('Older', arranged.older.length, `quiet for ${days}d+`));
    }
    // Only on the remote: someone's pushes — often an agent's — until one
    // is fetched into a branch of your own, which promotes it.
    if (arranged.remote.length) {
      this.groupRows.set('Remote', stackRows(arranged.remote));
      rows.push(new StackGroupItem('Remote', arranged.remote.length, 'not local'));
    }
    if (rows.length === 2) rows.push(new MessageItem('No branches of yours', `nothing leads into ${trunk} yet`));
    return rows;
  }

  /** Rows inside a folded group. Branch rows are leaves: Focus shows their commits. */
  children(element: TreeNode): TreeNode[] {
    if (element.kind === 'stackGroup') return this.groupRows.get(element.group) ?? [];
    return [];
  }

  private myLogin(cwd: string): Promise<string | undefined> {
    this.login ??= this.gh<{ login?: string }>(cwd, ['api', 'user'])
      .then((u) => u?.login)
      .catch(() => undefined);
    return this.login;
  }
}

function viaText(via: StackNode['via']): string {
  switch (via) {
    case 'pr':
      return 'its PR’s base';
    case 'recorded':
      return 'the base it was created from';
    case 'ancestry':
      return 'it contains that branch';
    default:
      return 'no other parent found';
  }
}

/** `branch.<name>.vscode-merge-base`, for every branch that has one. */
async function recordedBases(cwd: string): Promise<Map<string, string>> {
  const out = await git(cwd, [
    'config',
    '--get-regexp',
    '^branch\\..*\\.vscode-merge-base$',
  ]).catch(() => '');
  const map = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^branch\.(.+)\.vscode-merge-base (.+)$/.exec(line.trim());
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/**
 * Whose work a remote-only branch is: `user.email`, plus
 * `worktreeCompare.authorEmails` for agents that commit as someone else.
 */
async function authorEmails(cwd: string): Promise<Set<string>> {
  const configured = vscode.workspace
    .getConfiguration('worktreeCompare')
    .get<string[]>('authorEmails', []);
  const own = (await git(cwd, ['config', 'user.email']).catch(() => '')).trim();
  return new Set([own, ...configured].filter(Boolean).map((e) => e.toLowerCase()));
}

/** How far each root branch is behind the trunk, in one call. */
async function behindTrunk(
  cwd: string,
  trunk: string,
  roots: StackNode[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const names = roots.filter((n) => !n.name.startsWith(DETACHED));
  if (!names.length) return map;
  const out = await git(cwd, [
    'for-each-ref',
    `--format=%(refname)%00%(ahead-behind:${trunk})`,
    ...names.map((n) => (n.local ? `refs/heads/${n.name}` : `refs/remotes/origin/${n.name}`)),
  ]).catch(() => ''); // ahead-behind needs git 2.41; older just shows no lag
  for (const line of out.split('\n')) {
    const [ref, counts] = line.split('\0');
    if (!ref || !counts) continue;
    const name = ref.replace(/^refs\/(heads|remotes\/origin)\//, '');
    const lag = Number(counts.split(' ')[1]);
    if (lag) map.set(name, lag);
  }
  return map;
}

