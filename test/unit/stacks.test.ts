import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { arrangeStacks, layoutStack, planStacks, readStackRefs, type StackNode, type StacksInput } from '../../src/git/stacks';
import { addBranch, git, makeRepo, type ScratchRepo } from './helpers';

/**
 * Branches as stacks into the trunk. The rules under test: every branch has
 * exactly one parent, chosen by the strongest evidence available, and lists
 * only the commits its parent does not have.
 */
let r: ScratchRepo;
beforeEach(() => {
  r = makeRepo({ withOrigin: true });
});
afterEach(() => r.cleanup());

const me = { emails: new Set(['unit@test']), login: 'me' };

async function plan(extra: Partial<StacksInput> = {}) {
  const refs = await readStackRefs(r.repo, 'origin/main');
  return planStacks({ trunk: 'origin/main', ...refs, me, ...extra });
}

/** name → [parent, own commit count, restack], flattened over the forest. */
function shape(roots: StackNode[]): Record<string, [string, number, string?]> {
  const out: Record<string, [string, number, string?]> = {};
  const walk = (n: StackNode) => {
    out[n.name] = n.restack
      ? [n.parent ?? 'trunk', n.commits.length, n.restack]
      : [n.parent ?? 'trunk', n.commits.length];
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

function commitOn(branch: string, file: string, n = 1): void {
  git(r.repo, ['checkout', '-q', branch]);
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(r.repo, file), `${file} ${i}\n`);
    git(r.repo, ['add', '-A']);
    git(r.repo, ['commit', '-qm', `${branch}: ${file} ${i}`]);
  }
  git(r.repo, ['checkout', '-q', 'main']);
}

describe('stacks', () => {
  it('a branch cut from the trunk leads into it, with only its own commits', async () => {
    addBranch(r.repo, 'feat/a', 'a.txt', 'a\n');
    commitOn('feat/a', 'a2.txt');
    const p = await plan();
    expect(shape(p.roots)).toEqual({ 'feat/a': ['trunk', 2] });
    expect(p.roots[0].via).toBe('trunk');
  });

  it('a stack nests by ancestry, and no commit is listed twice', async () => {
    addBranch(r.repo, 'feat/foo', 'foo.txt', 'foo\n');
    addBranch(r.repo, 'feat/bar', 'bar.txt', 'bar\n', 'feat/foo');
    commitOn('feat/bar', 'bar2.txt');
    addBranch(r.repo, 'feat/baz', 'baz.txt', 'baz\n', 'feat/bar');
    const p = await plan();
    expect(shape(p.roots)).toEqual({
      'feat/foo': ['trunk', 1],
      'feat/bar': ['feat/foo', 2],
      'feat/baz': ['feat/bar', 1],
    });
    expect(p.roots[0].children[0].via).toBe('ancestry');
  });

  it('commits are oldest first', async () => {
    addBranch(r.repo, 'feat/a', 'a.txt', 'a\n');
    commitOn('feat/a', 'b.txt');
    const p = await plan();
    const subjects = p.roots[0].commits.map((sha) =>
      git(r.repo, ['log', '-1', '--format=%s', sha]),
    );
    expect(subjects).toEqual(['feat/a: a.txt', 'feat/a: b.txt 0']);
  });

  it('two branches at the same tip are siblings, not parent and child', async () => {
    addBranch(r.repo, 'feat/a', 'a.txt', 'a\n');
    git(r.repo, ['branch', 'feat/a-copy', 'feat/a']);
    const p = await plan();
    expect(shape(p.roots)).toEqual({ 'feat/a': ['trunk', 1], 'feat/a-copy': ['trunk', 1] });
  });

  it('a PR base outranks ancestry', async () => {
    addBranch(r.repo, 'feat/foo', 'foo.txt', 'foo\n');
    addBranch(r.repo, 'feat/bar', 'bar.txt', 'bar\n', 'feat/foo');
    const p = await plan({ prs: new Map([['feat/bar', { number: 2, base: 'main' }]]) });
    // Targeting the trunk on GitHub: it leads there, carrying foo's commit too.
    expect(shape(p.roots)).toEqual({ 'feat/foo': ['trunk', 1], 'feat/bar': ['trunk', 2] });
  });

  it('a recorded branch is used when there is no PR, and unknown names fall through', async () => {
    addBranch(r.repo, 'feat/foo', 'foo.txt', 'foo\n');
    addBranch(r.repo, 'feat/bar', 'bar.txt', 'bar\n', 'feat/foo');
    addBranch(r.repo, 'feat/baz', 'baz.txt', 'baz\n', 'feat/bar');
    const recorded = new Map([
      // baz sits on bar, but says it was cut for foo: the claim stands
      ['feat/baz', 'origin/feat/foo'],
      ['feat/foo', 'origin/gone-branch'],
    ]);
    const p = await plan({ recorded });
    expect(shape(p.roots)).toEqual({
      'feat/foo': ['trunk', 1],
      'feat/bar': ['feat/foo', 1],
      'feat/baz': ['feat/foo', 2],
    });
    expect(p.roots[0].children.find((n) => n.name === 'feat/baz')!.via).toBe('recorded');
    expect(p.roots[0].via).toBe('trunk');
  });

  it('a recorded trunk yields to a branch it provably sits on', async () => {
    // A branch cut from HEAD inside an agent's checkout records the default
    // (origin/main) while its history says it is stacked.
    addBranch(r.repo, 'feat/foo', 'foo.txt', 'foo\n');
    addBranch(r.repo, 'feat/bar', 'bar.txt', 'bar\n', 'feat/foo');
    addBranch(r.repo, 'feat/solo', 'solo.txt', 'solo\n');
    const recorded = new Map([
      ['feat/bar', 'origin/main'],
      ['feat/solo', 'origin/main'],
    ]);
    const p = await plan({ recorded });
    expect(shape(p.roots)).toEqual({
      'feat/foo': ['trunk', 1],
      'feat/bar': ['feat/foo', 1],
      'feat/solo': ['trunk', 1],
    });
    expect(p.roots.find((n) => n.name === 'feat/bar')).toBeUndefined();
    expect(p.roots.find((n) => n.name === 'feat/solo')!.via).toBe('recorded');
  });

  it('claims that loop are broken at the trunk', async () => {
    addBranch(r.repo, 'feat/a', 'a.txt', 'a\n');
    addBranch(r.repo, 'feat/b', 'b.txt', 'b\n');
    const prs = new Map([
      ['feat/a', { number: 1, base: 'feat/b' }],
      ['feat/b', { number: 2, base: 'feat/a' }],
    ]);
    const p = await plan({ prs });
    expect(p.roots.length).toBe(1);
    expect(Object.keys(shape(p.roots)).sort()).toEqual(['feat/a', 'feat/b']);
  });

  it('a landed parent moves its child to the trunk, flagged to restack', async () => {
    addBranch(r.repo, 'feat/foo', 'foo.txt', 'foo\n');
    addBranch(r.repo, 'feat/bar', 'bar.txt', 'bar\n', 'feat/foo');
    const p = await plan({ landed: new Set(['feat/foo']) });
    expect(shape(p.roots)).toEqual({ 'feat/bar': ['trunk', 1, 'feat/foo'] });
    expect(p.landed).toEqual(['feat/foo']);
  });

  it('a child already retargeted at the trunk still restacks over a landed ancestor', async () => {
    addBranch(r.repo, 'feat/foo', 'foo.txt', 'foo\n');
    addBranch(r.repo, 'feat/bar', 'bar.txt', 'bar\n', 'feat/foo');
    const p = await plan({
      landed: new Set(['feat/foo']),
      prs: new Map([['feat/bar', { number: 2, base: 'main' }]]),
    });
    expect(shape(p.roots)).toEqual({ 'feat/bar': ['trunk', 1, 'feat/foo'] });
  });

  it('local main is a row only while it holds unpushed commits, and it leads', async () => {
    addBranch(r.repo, 'feat/a', 'a.txt', 'a\n');
    expect(shape((await plan()).roots)).toEqual({ 'feat/a': ['trunk', 1] });
    commitOn('main', 'drift.txt');
    const p = await plan({ recorded: new Map([['feat/a', 'main']]) });
    expect(p.roots.map((n) => n.name)).toEqual(['main', 'feat/a']);
    // `main` as a recorded base means the trunk, not the local drift.
    expect(shape(p.roots)['feat/a']).toEqual(['trunk', 1]);
  });

  it('remote-only branches are mine by tip author or by my PR, and nobody else\'s are shown', async () => {
    const push = (branch: string, author: string) => {
      git(r.landing, ['checkout', '-q', '-b', branch, 'origin/main']);
      fs.writeFileSync(path.join(r.landing, `${branch.replace('/', '-')}.txt`), 'x\n');
      git(r.landing, ['add', '-A']);
      git(r.landing, ['commit', '-qm', branch, `--author=${author}`]);
      git(r.landing, ['push', '-q', 'origin', branch]);
    };
    push('agent/mine', 'Unit <unit@test>');
    push('agent/pr', 'Bot <bot@cloud>');
    push('other/theirs', 'Other <other@x>');
    git(r.repo, ['fetch', '-q', 'origin']);
    const p = await plan({
      prs: new Map([['agent/pr', { number: 9, base: 'main', authorLogin: 'me' }]]),
    });
    expect(Object.keys(shape(p.roots)).sort()).toEqual(['agent/mine', 'agent/pr']);
    expect(p.roots.every((n) => !n.local && n.remote)).toBe(true);
  });
});

describe('arrangeStacks', () => {
  const node = (name: string, children: StackNode[] = [], local = true): StackNode => ({
    name,
    via: 'trunk',
    commits: [],
    children,
    local,
    remote: !local,
  });
  const dates: Record<string, number> = { old: 10, recent: 100, newer: 200, child: 300, kept: 5, pin: 1 };
  const arrange = (roots: StackNode[], pinned: string[] = [], kept: string[] = []) => {
    const a = arrangeStacks(roots, {
      date: (n) => dates[n] ?? 0,
      pinned,
      keep: (n) => kept.includes(n),
      since: 50,
    });
    const names = (l: StackNode[]) => l.map((n) => n.name);
    return {
      pinned: names(a.pinned),
      active: names(a.active),
      older: names(a.older),
      remote: names(a.remote),
    };
  };

  it('puts recent work first and folds the rest away, newest first', () => {
    expect(arrange([node('old'), node('recent'), node('newer'), node('kept')])).toEqual({
      pinned: [],
      active: ['newer', 'recent'],
      older: ['old', 'kept'],
      remote: [],
    });
  });

  it('keeps a checkout or preview lane prominent however old it is', () => {
    expect(arrange([node('old'), node('kept')], [], ['kept']).active).toEqual(['kept']);
  });

  it('pins lead, in pin order, and a pinned branch carries its whole stack', () => {
    const a = arrange([node('old', [node('pin')]), node('recent'), node('kept')], ['kept', 'pin']);
    expect(a.pinned).toEqual(['kept', 'old']);
    expect(a.active).toEqual(['recent']);
  });

  it('a stack is as live as its liveliest branch', () => {
    expect(arrange([node('old', [node('child')])]).active).toEqual(['old']);
  });

  it('never promotes a remote-only stack by recency, but a pin or a local child does', () => {
    const a = arrange([node('newer', [], false), node('old'), node('child', [], false)], ['child']);
    expect(a).toEqual({ pinned: ['child'], active: [], older: ['old'], remote: ['newer'] });
    expect(arrange([node('old', [node('child')], false)]).active).toEqual(['old']);
  });
});

describe('layoutStack', () => {
  const node = (name: string, children: StackNode[] = []): StackNode => ({
    name,
    via: 'ancestry',
    commits: [],
    children,
    local: true,
    remote: false,
  });
  const draw = (root: StackNode) =>
    layoutStack(root).map((l) => (l.prefix + l.node.name).replace(/ /g, ' '));

  it('steps siblings in with ├ and └', () => {
    expect(draw(node('fix/new-init', [node('feat/run'), node('spike/a'), node('spike/b')]))).toEqual([
      'fix/new-init',
      '├ feat/run',
      '├ spike/a',
      '└ spike/b',
    ]);
  });

  it('keeps a linear stack at one indent, marked as on the row above', () => {
    expect(draw(node('foo', [node('bar', [node('baz')])]))).toEqual(['foo', '↳ bar', '↳ baz']);
  });

  it('carries an open fork past a chain nested under it', () => {
    expect(
      draw(node('root', [node('a', [node('a2', [node('a3')])]), node('b', [node('b1'), node('b2')])])),
    ).toEqual(['root', '├ a', '│ ↳ a2', '│ ↳ a3', '└ b', '  ├ b1', '  └ b2']);
  });

  it('forks off the top of a linear stack', () => {
    expect(draw(node('foo', [node('bar', [node('x'), node('y')])]))).toEqual([
      'foo',
      '↳ bar',
      '  ├ x',
      '  └ y',
    ]);
  });
});
