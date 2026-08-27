/**
 * The petty-conflict matrix (formerly scripts/stress/conflicts.mjs), as
 * assertions against the REAL resolver pipeline — mergeOffTree +
 * resolveConflictedTree — instead of a mirrored copy that could drift.
 *
 * Each archetype is a two-lane repo shaped like a real clash. Expectations
 * cover both shipped resolver tiers ('whitespace' → lossless, the
 * 'best-effort' default → full):
 *   - petty archetypes must integrate cleanly in BOTH tiers, and where
 *     both lanes add content, both intents must survive (never silently
 *     dropped — that regression is exactly what this matrix exists for);
 *   - genuinely divergent archetypes must CONFLICT under lossless and
 *     resolve lane-wins TAGGED LOSSY under full;
 *   - delete-vs-edit stays a real conflict in every tier.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mergeOffTree,
  resolveConflictedTree,
} from '../../src/git/integration/merge';
import { git } from './helpers';

const BASE_FILES: Record<string, string> = {
  'src/app.ts': [
    'export function main() {',
    '  const config = loadConfig();',
    '  const server = createServer(config);',
    '  server.listen(config.port);',
    '  log("listening", config.port);',
    '}',
    '',
    'function loadConfig() {',
    '  return {',
    '    port: 3000,',
    '    host: "localhost",',
    '    debug: false,',
    '  };',
    '}',
    '',
    'function createServer(config) {',
    '  return new Server(config);',
    '}',
    '',
    'function log(...args) {',
    '  console.log(...args);',
    '}',
    '',
  ].join('\n'),
  'src/imports.ts': [
    'import { a } from "./a";',
    'import { b } from "./b";',
    'import { c } from "./c";',
    '',
    'export { a, b, c };',
    '',
  ].join('\n'),
  'CHANGELOG.md': ['# Changelog', '', '- initial release', ''].join('\n'),
  'config.yaml': ['name: demo', 'version: 1', 'features:', '  - core', ''].join(
    '\n',
  ),
};

type Mutate = (dir: string) => void;

interface Archetype {
  name: string;
  laneA: Mutate;
  laneB: Mutate;
  /** Base moves AFTER the lanes fork (stale-lane shapes). */
  base?: Mutate;
  /** petty: must integrate cleanly in BOTH shipped tiers. */
  expect:
    | { kind: 'petty'; bothSurvive?: [string, string, string] }
    /** divergent: conflict under lossless, lane-wins lossy under full. */
    | { kind: 'lossy'; file: string }
    /** conflict: refused in every tier (checkout untouched). */
    | { kind: 'conflict' };
}

function edit(dir: string, rel: string, fn: (s: string) => string | null) {
  const abs = path.join(dir, rel);
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const after = fn(before);
  if (after === null) {
    fs.rmSync(abs);
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, after);
  }
}

const ARCHETYPES: Archetype[] = [
  {
    name: 'disjoint-files',
    expect: { kind: 'petty' },
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('debug: false', 'debug: true')),
    laneB: (d) => edit(d, 'config.yaml', (s) => s.replace('version: 1', 'version: 2')),
  },
  {
    name: 'same-file-far-apart',
    expect: { kind: 'petty' },
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 8080')),
    laneB: (d) => edit(d, 'src/app.ts', (s) => s.replace('console.log(...args);', 'console.error(...args);')),
  },
  {
    name: 'adjacent-lines',
    expect: { kind: 'petty' },
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('    port: 3000,', '    port: 8080,')),
    laneB: (d) => edit(d, 'src/app.ts', (s) => s.replace('    host: "localhost",', '    host: "0.0.0.0",')),
  },
  {
    name: 'same-line-divergent',
    expect: { kind: 'lossy', file: 'src/app.ts' },
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 8080')),
    laneB: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 9090')),
  },
  {
    name: 'same-change-duplicated',
    expect: { kind: 'petty' },
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 8080')),
    laneB: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 8080')),
  },
  {
    name: 'same-change-diff-whitespace',
    expect: { kind: 'petty' },
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('    port: 3000,', '    port: 8080,')),
    laneB: (d) => edit(d, 'src/app.ts', (s) => s.replace('    port: 3000,', '\tport: 8080,')),
  },
  {
    name: 'append-same-file',
    expect: {
      kind: 'petty',
      bothSurvive: ['- lane A shipped', '- lane B shipped', 'CHANGELOG.md'],
    },
    laneA: (d) => edit(d, 'CHANGELOG.md', (s) => `${s}- lane A shipped\n`),
    laneB: (d) => edit(d, 'CHANGELOG.md', (s) => `${s}- lane B shipped\n`),
  },
  {
    name: 'import-list-insert',
    expect: {
      kind: 'petty',
      bothSurvive: ['import { x }', 'import { y }', 'src/imports.ts'],
    },
    laneA: (d) =>
      edit(d, 'src/imports.ts', (s) =>
        s.replace('import { c } from "./c";', 'import { c } from "./c";\nimport { x } from "./x";'),
      ),
    laneB: (d) =>
      edit(d, 'src/imports.ts', (s) =>
        s.replace('import { c } from "./c";', 'import { c } from "./c";\nimport { y } from "./y";'),
      ),
  },
  {
    name: 'insert-same-point',
    expect: {
      kind: 'petty',
      bothSurvive: ['  - laneA', '  - laneB', 'config.yaml'],
    },
    laneA: (d) => edit(d, 'config.yaml', (s) => s.replace('  - core', '  - core\n  - laneA')),
    laneB: (d) => edit(d, 'config.yaml', (s) => s.replace('  - core', '  - core\n  - laneB')),
  },
  {
    name: 'add-add-different',
    expect: { kind: 'lossy', file: 'src/new.ts' },
    laneA: (d) => edit(d, 'src/new.ts', () => 'export const from = "A";\n'),
    laneB: (d) => edit(d, 'src/new.ts', () => 'export const from = "B";\n'),
  },
  {
    name: 'add-add-identical',
    expect: { kind: 'petty' },
    laneA: (d) => edit(d, 'src/new.ts', () => 'export const shared = 1;\n'),
    laneB: (d) => edit(d, 'src/new.ts', () => 'export const shared = 1;\n'),
  },
  {
    name: 'edit-vs-delete',
    expect: { kind: 'conflict' },
    laneA: (d) => edit(d, 'config.yaml', (s) => s.replace('version: 1', 'version: 2')),
    laneB: (d) => edit(d, 'config.yaml', () => null),
  },
  {
    name: 'rename-vs-edit',
    expect: { kind: 'petty' },
    laneA: (d) => {
      fs.renameSync(path.join(d, 'src/imports.ts'), path.join(d, 'src/index.ts'));
    },
    laneB: (d) =>
      edit(d, 'src/imports.ts', (s) => s.replace('import { a } from "./a";', 'import { a2 } from "./a";')),
  },
  {
    // Base moves AFTER lane A forks; lane A's edit is unrelated to the
    // base's — staleness alone must not conflict.
    name: 'stale-lane-unrelated',
    expect: { kind: 'petty' },
    base: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 4000')),
    laneA: (d) => edit(d, 'CHANGELOG.md', (s) => `${s}- stale lane work\n`),
    laneB: (d) => edit(d, 'config.yaml', (s) => s.replace('version: 1', 'version: 2')),
  },
  {
    // Stale lane edited the SAME region the base later rewrote.
    name: 'stale-lane-overlap',
    expect: { kind: 'lossy', file: 'src/app.ts' },
    base: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 4000')),
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 8080')),
    laneB: (d) => edit(d, 'config.yaml', (s) => s.replace('version: 1', 'version: 2')),
  },
];

function buildRepo(archetype: Archetype) {
  const repo = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'gw-resolver-')),
  );
  git(repo, ['init', '-q', '-b', 'main']);
  for (const [rel, content] of Object.entries(BASE_FILES)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  const fork = git(repo, ['rev-parse', 'HEAD']);

  const makeLane = (name: string, mutate: Mutate) => {
    git(repo, ['checkout', '-q', '-b', name, fork]);
    mutate(repo);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', name]);
    return git(repo, ['rev-parse', 'HEAD']);
  };
  const laneA = makeLane('lane-a', archetype.laneA);
  const laneB = makeLane('lane-b', archetype.laneB);

  git(repo, ['checkout', '-q', 'main']);
  if (archetype.base) {
    archetype.base(repo);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base moves']);
  }
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  return {
    repo,
    baseSha,
    lanes: [
      ['lane-a', laneA],
      ['lane-b', laneB],
    ] as [string, string][],
  };
}

type ChainResult =
  | { failedLane: string; files: string[] }
  | { tip: string; lossy: string[]; lossless: string[] };

/** The engine's merge chain (engine.ts) over the real resolver seam. */
async function integrate(
  repo: string,
  baseSha: string,
  lanes: [string, string][],
  mode: 'lossless' | 'full',
): Promise<ChainResult> {
  let current = baseSha;
  const lossy: string[] = [];
  const lossless: string[] = [];
  for (const [name, sha] of lanes) {
    const step = await mergeOffTree(repo, current, sha);
    if (step.kind === 'unsupported')
      throw new Error('git < 2.38: merge-tree --write-tree unavailable');
    let tree: string;
    if (step.kind === 'conflict') {
      const res = await resolveConflictedTree(
        repo,
        current,
        sha,
        step.tree,
        step.files,
        mode,
      );
      if ('unresolved' in res)
        return { failedLane: name, files: res.unresolved };
      tree = res.tree;
      lossy.push(...res.lossy.map((f) => `${name}:${f}`));
      lossless.push(...res.lossless.map((f) => `${name}:${f}`));
    } else {
      tree = step.tree;
    }
    // helpers.git, not a raw spawn: commit-tree needs the committer
    // identity the helper injects (CI runners have no global git config)
    current = git(repo, [
      'commit-tree',
      tree,
      '-p',
      current,
      '-p',
      sha,
      '-m',
      `integrate ${name}`,
    ]);
  }
  return { tip: current, lossy, lossless };
}

describe('conflict resolver — petty-conflict matrix', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  const build = (a: Archetype) => {
    const built = buildRepo(a);
    cleanups.push(() => fs.rmSync(built.repo, { recursive: true, force: true }));
    return built;
  };

  for (const a of ARCHETYPES) {
    describe(a.name, () => {
      if (a.expect.kind === 'petty') {
        const survive = a.expect.bothSurvive;
        for (const mode of ['lossless', 'full'] as const) {
          it(`integrates cleanly (${mode}), nothing lost`, async () => {
            const { repo, baseSha, lanes } = build(a);
            const result = await integrate(repo, baseSha, lanes, mode);
            expect(result).not.toHaveProperty('failedLane');
            if ('tip' in result) {
              expect(result.lossy).toEqual([]);
              if (survive) {
                const [needleA, needleB, file] = survive;
                const content = git(repo, ['show', `${result.tip}:${file}`]);
                expect(content).toContain(needleA);
                expect(content).toContain(needleB);
              }
            }
          });
        }
      }
      if (a.expect.kind === 'lossy') {
        const file = a.expect.file;
        it('conflicts under lossless (never guesses)', async () => {
          const { repo, baseSha, lanes } = build(a);
          const result = await integrate(repo, baseSha, lanes, 'lossless');
          expect(result).toHaveProperty('failedLane');
          if ('files' in result) expect(result.files).toContain(file);
        });
        it('resolves lane-wins under full, tagged lossy', async () => {
          const { repo, baseSha, lanes } = build(a);
          const result = await integrate(repo, baseSha, lanes, 'full');
          expect(result).not.toHaveProperty('failedLane');
          if ('tip' in result)
            expect(result.lossy.some((l) => l.endsWith(`:${file}`))).toBe(true);
        });
      }
      if (a.expect.kind === 'conflict') {
        for (const mode of ['lossless', 'full'] as const) {
          it(`stays a real conflict (${mode})`, async () => {
            const { repo, baseSha, lanes } = build(a);
            const result = await integrate(repo, baseSha, lanes, mode);
            expect(result).toHaveProperty('failedLane');
          });
        }
      }
    });
  }
});
