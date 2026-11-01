import { git } from './exec';

/**
 * Branches as STACKS leading into a trunk — the model behind a
 * branch-first Lanes panel, where a worktree is a badge on a branch rather
 * than the thing a row stands for.
 *
 * Every branch gets exactly one parent: another branch, or the trunk. The
 * parent is decided by evidence, strongest first:
 *
 *   pr        the base of the branch's open PR
 *   recorded  the base it recorded when created (vscode-merge-base) —
 *             when that names a branch; a recorded trunk is only the
 *             default, and yields to ancestry
 *   ancestry  the nearest other branch whose tip it contains
 *   trunk     nothing else said otherwise
 *
 * A branch then lists only its OWN commits — reachable from its tip, not
 * from its parent's — so a stack never shows a commit twice.
 *
 * Planning is pure (planStacks), over a commit graph that holds only what
 * the trunk does not: everything the panel needs comes from two git calls
 * (readStacks), however many branches there are.
 */

export interface StackBranch {
  /** Short name, without the remote prefix. */
  name: string;
  /** Tip sha — the local ref's when there is one, else origin's. */
  tip: string;
  /** Unix seconds of the tip commit. */
  date: number;
  local: boolean;
  remote: boolean;
  /** Author email of the tip commit — how a remote-only branch is claimed. */
  authorEmail?: string;
}

export interface StackPr {
  number: number;
  /** Base branch name as GitHub reports it (`main`, `feat/foo`). */
  base?: string;
  authorLogin?: string;
}

export interface StacksInput {
  /** The ref everything leads into, e.g. `origin/main`. */
  trunk: string;
  branches: StackBranch[];
  /**
   * Parents of every commit the trunk does not contain, in `rev-list
   * --topo-order` order (newest first). A parent missing from the map is on
   * the trunk.
   */
  graph: Map<string, string[]>;
  /** Open PRs by head branch name. */
  prs?: ReadonlyMap<string, StackPr>;
  /** Recorded bases by branch name (`origin/main`, `feat/foo`, `main`). */
  recorded?: ReadonlyMap<string, string>;
  /** Branches whose work is CONFIRMED in the trunk (see landedProbe). */
  landed?: ReadonlySet<string>;
  /** Who "mine" is: local branches always are; remote-only ones must prove it. */
  me: { emails: ReadonlySet<string>; login?: string };
}

export type ParentSource = 'pr' | 'recorded' | 'ancestry' | 'trunk';

export interface StackNode {
  name: string;
  /** Parent branch name, or undefined for the trunk. */
  parent?: string;
  via: ParentSource;
  /** This branch's own commits, oldest first. */
  commits: string[];
  /** Branches stacked directly on this one, oldest tip first. */
  children: StackNode[];
  /**
   * The landed branch this one still carries the commits of. Set when the
   * parent has landed — the branch now leads into the trunk, but replaying
   * it needs `rebase --onto` to drop what already went in.
   */
  restack?: string;
  local: boolean;
  remote: boolean;
}

export interface StacksPlan {
  /** Branches leading straight into the trunk, oldest tip first. */
  roots: StackNode[];
  /** Mine, landed — waiting to be pruned, not part of any stack. */
  landed: string[];
}

/** The trunk's short branch name: `origin/main` → `main`. */
function trunkName(trunk: string): string {
  return trunk.replace(/^(refs\/remotes\/)?origin\//, '');
}

function isMine(b: StackBranch, prs: StacksInput['prs'], me: StacksInput['me']): boolean {
  if (b.local) return true;
  const pr = prs?.get(b.name);
  if (pr && me.login && pr.authorLogin === me.login) return true;
  return !!b.authorEmail && me.emails.has(b.authorEmail.toLowerCase());
}

export function planStacks(input: StacksInput): StacksPlan {
  const { graph } = input;
  const trunk = trunkName(input.trunk);
  const landedSet = input.landed ?? new Set<string>();

  const mine = input.branches.filter((b) => isMine(b, input.prs, input.me));
  const byName = new Map(mine.map((b) => [b.name, b]));

  // Topo position, newest first — sorting by it descending gives oldest first.
  const order = new Map<string, number>();
  for (const sha of graph.keys()) order.set(sha, order.size);

  // Everything reachable from a tip that the trunk lacks. Memoized: stacked
  // branches share most of theirs.
  const reachMemo = new Map<string, Set<string>>();
  const reach = (tip: string): Set<string> => {
    const hit = reachMemo.get(tip);
    if (hit) return hit;
    const seen = new Set<string>();
    const todo = [tip];
    while (todo.length) {
      const sha = todo.pop()!;
      if (seen.has(sha) || !graph.has(sha)) continue;
      seen.add(sha);
      todo.push(...graph.get(sha)!);
    }
    reachMemo.set(tip, seen);
    return seen;
  };

  /** A base ref named by PR or config, as a branch of ours or the trunk. */
  const resolveNamed = (ref: string | undefined, self: string): string | null | undefined => {
    if (!ref) return undefined;
    const short = ref.replace(/^(refs\/heads\/|refs\/remotes\/origin\/|origin\/)/, '');
    if (short === trunk) return null;
    if (short !== self && byName.has(short)) return short;
    return undefined;
  };

  /** The nearest other branch whose tip this one contains. */
  const nearestAncestor = (b: StackBranch): string | undefined => {
    const mineReach = reach(b.tip);
    let best: StackBranch | undefined;
    for (const other of mine) {
      // Equal tips contain each other; neither is the other's parent.
      if (other === b || other.tip === b.tip || !mineReach.has(other.tip)) continue;
      if (!best || reach(other.tip).size > reach(best.tip).size) best = other;
    }
    return best?.name;
  };

  // First pass: each branch's claimed parent (null = trunk).
  const parentOf = new Map<string, { parent: string | null; via: ParentSource }>();
  for (const b of mine) {
    if (landedSet.has(b.name)) continue;
    // The local trunk (`main` beside `origin/main`) leads into it, always.
    if (b.name === trunk) {
      parentOf.set(b.name, { parent: null, via: 'trunk' });
      continue;
    }
    const pr = resolveNamed(input.prs?.get(b.name)?.base, b.name);
    const recorded = pr === undefined ? resolveNamed(input.recorded?.get(b.name), b.name) : undefined;
    if (pr !== undefined) parentOf.set(b.name, { parent: pr, via: 'pr' });
    // A recorded branch is a claim; a recorded trunk is usually just the
    // default a checkout was cut with, so a branch it provably sits on wins.
    else if (recorded) parentOf.set(b.name, { parent: recorded, via: 'recorded' });
    else {
      const anc = nearestAncestor(b);
      parentOf.set(
        b.name,
        anc
          ? { parent: anc, via: 'ancestry' }
          : { parent: null, via: recorded === null ? 'recorded' : 'trunk' },
      );
    }
  }

  // Claims can loop (A's PR targets B, B's targets A) — break a cycle by
  // sending the branch that closes it to the trunk.
  for (const start of parentOf.keys()) {
    const path = new Set<string>([start]);
    let cur = parentOf.get(start)?.parent;
    while (cur) {
      if (path.has(cur)) {
        parentOf.set(start, { parent: null, via: 'trunk' });
        break;
      }
      path.add(cur);
      cur = parentOf.get(cur)?.parent ?? undefined;
    }
  }

  const nodes = new Map<string, StackNode>();
  for (const [name, { parent, via }] of parentOf) {
    const b = byName.get(name)!;
    let restack: string | undefined;
    let effective = parent;
    if (parent && landedSet.has(parent)) {
      // The parent landed: this branch leads into the trunk now, still
      // carrying commits that went in under another sha.
      restack = parent;
      effective = null;
    } else if (parent === null) {
      const anc = nearestAncestor(b);
      if (anc && landedSet.has(anc)) restack = anc;
    }
    // Own commits are measured from the parent it was cut from, landed or
    // not — what already went in is the restack's problem, not this list's.
    const from = restack ?? parent;
    const exclude = from && byName.has(from) ? reach(byName.get(from)!.tip) : new Set<string>();
    const commits = [...reach(b.tip)]
      .filter((sha) => !exclude.has(sha))
      .sort((x, y) => order.get(y)! - order.get(x)!);
    // The local trunk is only worth a row when it holds something origin's does not.
    if (name === trunk && !commits.length) continue;
    nodes.set(name, {
      name,
      parent: effective ?? undefined,
      via,
      commits,
      children: [],
      restack,
      local: b.local,
      remote: b.remote,
    });
  }

  const byDate = (x: StackNode, y: StackNode) =>
    byName.get(x.name)!.date - byName.get(y.name)!.date;
  const roots: StackNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent ? nodes.get(node.parent) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) node.children.sort(byDate);
  // The local trunk leads, then everything else oldest tip first.
  roots.sort((x, y) => (x.name === trunk ? -1 : y.name === trunk ? 1 : byDate(x, y)));

  return {
    roots,
    landed: mine.filter((b) => landedSet.has(b.name)).map((b) => b.name),
  };
}

/** What a commit row shows. */
export interface StackCommit {
  sha: string;
  short: string;
  subject: string;
  /** Relative author date, `3 hours ago`. */
  when: string;
}

/**
 * Everything planStacks needs from git: branch tips, and the graph off the
 * trunk — with each commit's subject, since the rows show them anyway.
 * `extraTips` are heads with no branch (a detached checkout) whose commits
 * the graph must still hold.
 */
export async function readStackRefs(
  repo: string,
  trunk: string,
  extraTips: string[] = [],
): Promise<{
  branches: StackBranch[];
  graph: Map<string, string[]>;
  commits: Map<string, StackCommit>;
}> {
  const out = await git(repo, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(authoremail)',
    'refs/heads',
    'refs/remotes/origin',
  ]);
  const byName = new Map<string, StackBranch>();
  for (const line of out.split('\n')) {
    const [refname, tip, date, email] = line.split('\0');
    if (!refname || !tip) continue;
    const local = refname.startsWith('refs/heads/');
    const prefix = local ? 'refs/heads/' : 'refs/remotes/origin/';
    if (!refname.startsWith(prefix)) continue;
    const name = refname.slice(prefix.length);
    if (name === 'HEAD') continue;
    const existing = byName.get(name);
    // The local ref is where work happens; origin's tip only stands in for
    // a branch that has none.
    if (existing) {
      existing.local ||= local;
      existing.remote ||= !local;
      if (local) {
        existing.tip = tip;
        existing.date = Number(date) || 0;
        existing.authorEmail = email?.replace(/[<>]/g, '').toLowerCase();
      }
      continue;
    }
    byName.set(name, {
      name,
      tip,
      date: Number(date) || 0,
      local,
      remote: !local,
      authorEmail: email?.replace(/[<>]/g, '').toLowerCase(),
    });
  }
  const trunkShort = trunkName(trunk);
  const branches = [...byName.values()].filter(
    (b) => b.name !== trunkShort || b.local,
  );

  const graph = new Map<string, string[]>();
  const commits = new Map<string, StackCommit>();
  const tips = [...new Set([...branches.map((b) => b.tip), ...extraTips])];
  if (tips.length) {
    const revs = await git(repo, [
      'log',
      '--topo-order',
      '--format=%H %P%x00%h%x00%ar%x00%s',
      ...tips,
      '--not',
      trunk,
      '--',
    ]);
    for (const line of revs.split('\n')) {
      const [ids, short, when, subject] = line.split('\0');
      const [sha, ...parents] = (ids ?? '').trim().split(' ');
      if (!sha) continue;
      graph.set(sha, parents.filter(Boolean));
      commits.set(sha, { sha, short: short ?? '', subject: subject ?? '', when: when ?? '' });
    }
  }
  return { branches, graph, commits };
}

export interface StackArrangement {
  /** Stacks holding a pinned branch, in the order they were pinned. */
  pinned: StackNode[];
  /** Stacks being worked on, most recent activity first. */
  active: StackNode[];
  /** Local stacks nothing has happened to lately, most recent first. */
  older: StackNode[];
  /** Stacks with no local branch at all, most recent first. */
  remote: StackNode[];
}

/**
 * Which stacks are prominent. A stack moves as a unit — its branches are
 * one piece of work — and is as live as its liveliest branch:
 *
 *   pinned   any branch in it is pinned
 *   active   any branch is kept (a checkout, in the preview, uncommitted
 *            work), or it holds a local branch with a tip newer than `since`
 *   older    local, but nothing has happened to it lately
 *   remote   nothing in it is local
 *
 * Keeping a branch local is itself a claim on it — a lighter pin — so
 * recency alone never promotes a remote-only stack, however fresh: those
 * are someone's pushes (often an agent's) until you fetch one into a
 * branch of your own. Active stacks lead with the most recent, since that
 * is the work you are most likely to want next; age says nothing about a
 * checkout you left open, which is why `keep` outranks it.
 */
export function arrangeStacks(
  roots: StackNode[],
  opts: {
    date: (name: string) => number;
    pinned: readonly string[];
    keep: (name: string) => boolean;
    /** Unix seconds; a tip at or after this is recent. */
    since: number;
  },
): StackArrangement {
  const nodes = (n: StackNode): StackNode[] => [n, ...n.children.flatMap(nodes)];
  const scored = roots.map((root) => {
    const all = nodes(root);
    const pins = all.map((n) => opts.pinned.indexOf(n.name)).filter((i) => i >= 0);
    return {
      root,
      pin: pins.length ? Math.min(...pins) : -1,
      activity: Math.max(...all.map((n) => opts.date(n.name))),
      kept: all.some((n) => opts.keep(n.name)),
      local: all.some((n) => n.local),
    };
  });
  type Scored = (typeof scored)[number];
  const recentFirst = (a: Scored, b: Scored) => b.activity - a.activity;
  const pinned = scored.filter((s) => s.pin >= 0).sort((a, b) => a.pin - b.pin);
  const rest = scored.filter((s) => s.pin < 0);
  const live = (s: Scored) => s.kept || (s.local && s.activity >= opts.since);
  const roots_ = (l: Scored[]) => l.sort(recentFirst).map((s) => s.root);
  return {
    pinned: pinned.map((s) => s.root),
    active: roots_(rest.filter(live)),
    older: roots_(rest.filter((s) => !live(s) && s.local)),
    remote: roots_(rest.filter((s) => !live(s) && !s.local)),
  };
}

/** One row of a drawn stack: the branch, and what goes in front of its name. */
export interface StackLine {
  node: StackNode;
  /** Indent and connector glyph, e.g. `│ ├ ` or `↳ `. Empty for the root. */
  prefix: string;
}

/** Wide enough to stand in for a glyph and its space, and never trimmed. */
const BLANK = ' ';

/**
 * A stack as rows, telling the two shapes apart:
 *
 *   fix/new-init                 SIBLINGS — several branches on one parent
 *   ├ feat/run                   step in, with ├ / └ and a │ carrying
 *   │ ↳ feat/run-more            an open fork past what nests under it
 *   └ spike/get-thenable
 *   feat/foo                     A LINEAR STACK — each on the one above
 *   ↳ feat/bar                   stays at one indent however tall it grows
 *   ↳ feat/baz
 */
export function layoutStack(root: StackNode): StackLine[] {
  const lines: StackLine[] = [];
  // `lead` is the prefix minus this row's own glyph; `glyph` is the glyph.
  const walk = (node: StackNode, lead: string, glyph: string) => {
    lines.push({ node, prefix: lead + glyph });
    const kids = node.children;
    if (kids.length === 1) {
      // A chain continues in the same column; under a fork branch it steps
      // past that branch's connector first.
      const next = glyph === '' || glyph === '↳ ' ? lead : lead + carry(glyph);
      walk(kids[0], next, '↳ ');
      return;
    }
    const inner = lead + carry(glyph);
    kids.forEach((kid, i) => walk(kid, inner, i === kids.length - 1 ? '└ ' : '├ '));
  };
  walk(root, '', '');
  return lines;
}

/** What a row's glyph leaves for the rows beneath it. */
function carry(glyph: string): string {
  if (glyph === '') return '';
  return glyph === '├ ' ? `│${BLANK}` : `${BLANK}${BLANK}`;
}
