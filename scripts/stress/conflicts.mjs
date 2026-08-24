#!/usr/bin/env node
/**
 * Stress-test the integration overlay's conflict surface.
 *
 * Replays the engine's exact merge chain (git merge-tree --write-tree
 * --name-only [-X args], then commit-tree) over generated two-lane
 * conflict archetypes, at every integrationAutoResolve tier, and reports:
 *   - which archetypes hard-fail per tier (the "petty conflict" matrix)
 *   - lossiness: when a tier auto-resolves, did both lanes' intents
 *     survive in the final tree?
 *
 * Usage: node scripts/stress/conflicts.mjs [workdir]
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'gw-stress-'));

function git(cwd, args, allowFail = false) {
  try {
    return {
      code: 0,
      out: execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LANG: 'C' },
      }),
    };
  } catch (err) {
    if (!allowFail) {
      throw err;
    }
    return { code: err.status ?? 1, out: err.stdout?.toString() ?? '' };
  }
}

const BASE_FILES = {
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

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function edit(dir, rel, fn) {
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

/** Each archetype: { name, petty, laneA(dir), laneB(dir), base?(dir),
 *  bothSurvive?: [needleA, needleB, file] } */
const ARCHETYPES = [
  {
    name: 'disjoint-files',
    petty: true,
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('debug: false', 'debug: true')),
    laneB: (d) => edit(d, 'config.yaml', (s) => s.replace('version: 1', 'version: 2')),
  },
  {
    name: 'same-file-far-apart',
    petty: true,
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 8080')),
    laneB: (d) => edit(d, 'src/app.ts', (s) => s.replace('console.log(...args);', 'console.error(...args);')),
  },
  {
    name: 'adjacent-lines',
    petty: true,
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('    port: 3000,', '    port: 8080,')),
    laneB: (d) => edit(d, 'src/app.ts', (s) => s.replace('    host: "localhost",', '    host: "0.0.0.0",')),
  },
  {
    name: 'same-line-divergent',
    petty: false,
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 8080')),
    laneB: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 9090')),
  },
  {
    name: 'same-change-duplicated',
    petty: true,
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 8080')),
    laneB: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 8080')),
  },
  {
    name: 'same-change-diff-whitespace',
    petty: true,
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('    port: 3000,', '    port: 8080,')),
    laneB: (d) => edit(d, 'src/app.ts', (s) => s.replace('    port: 3000,', '\tport: 8080,')),
  },
  {
    name: 'append-same-file',
    petty: true,
    bothSurvive: ['- lane A shipped', '- lane B shipped', 'CHANGELOG.md'],
    laneA: (d) => edit(d, 'CHANGELOG.md', (s) => `${s}- lane A shipped\n`),
    laneB: (d) => edit(d, 'CHANGELOG.md', (s) => `${s}- lane B shipped\n`),
  },
  {
    name: 'import-list-insert',
    petty: true,
    bothSurvive: ['import { x }', 'import { y }', 'src/imports.ts'],
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
    petty: true,
    bothSurvive: ['  - laneA', '  - laneB', 'config.yaml'],
    laneA: (d) => edit(d, 'config.yaml', (s) => s.replace('  - core', '  - core\n  - laneA')),
    laneB: (d) => edit(d, 'config.yaml', (s) => s.replace('  - core', '  - core\n  - laneB')),
  },
  {
    name: 'add-add-different',
    petty: false,
    laneA: (d) => edit(d, 'src/new.ts', () => 'export const from = "A";\n'),
    laneB: (d) => edit(d, 'src/new.ts', () => 'export const from = "B";\n'),
  },
  {
    name: 'add-add-identical',
    petty: true,
    laneA: (d) => edit(d, 'src/new.ts', () => 'export const shared = 1;\n'),
    laneB: (d) => edit(d, 'src/new.ts', () => 'export const shared = 1;\n'),
  },
  {
    name: 'edit-vs-delete',
    petty: false,
    laneA: (d) => edit(d, 'config.yaml', (s) => s.replace('version: 1', 'version: 2')),
    laneB: (d) => edit(d, 'config.yaml', () => null),
  },
  {
    name: 'rename-vs-edit',
    petty: true,
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
    petty: true,
    base: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 4000')),
    laneA: (d) => edit(d, 'CHANGELOG.md', (s) => `${s}- stale lane work\n`),
    laneB: (d) => edit(d, 'config.yaml', (s) => s.replace('version: 1', 'version: 2')),
  },
  {
    // Stale lane edited the SAME region the base later rewrote.
    name: 'stale-lane-overlap',
    petty: false,
    base: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 4000')),
    laneA: (d) => edit(d, 'src/app.ts', (s) => s.replace('port: 3000', 'port: 8080')),
    laneB: (d) => edit(d, 'config.yaml', (s) => s.replace('version: 1', 'version: 2')),
  },
];

const TIERS = [
  ['off', []],
  ['whitespace', ['-X', 'ignore-space-change']],
  ['legacy-lane-wins', ['-X', 'theirs', '-X', 'ignore-space-change']],
];

// --- best-effort pipeline (mirrors src/git/integration/merge.ts) ----------

function bothSidesOnlyInsert(base, ours, theirs) {
  const b = base.split('\n');
  const isSuperset = (side) => {
    const lines = side.split('\n');
    let i = 0;
    for (const line of lines) {
      if (i < b.length && line === b[i]) i++;
    }
    return i === b.length;
  };
  return isSuperset(ours) && isSuperset(theirs);
}

function mergeLinewise(base, ours, theirs) {
  const b = base.split('\n');
  const o = ours.split('\n');
  const t = theirs.split('\n');
  if (b.length !== o.length || b.length !== t.length) return undefined;
  const out = [];
  for (let i = 0; i < b.length; i++) {
    if (o[i] === t[i]) out.push(o[i]);
    else if (o[i] === b[i]) out.push(t[i]);
    else if (t[i] === b[i]) out.push(o[i]);
    else return undefined;
  }
  return out.join('\n');
}

function mergeFileFlag(repo, tmp, base, ours, theirs, flag) {
  fs.writeFileSync(path.join(tmp, 'b'), base);
  fs.writeFileSync(path.join(tmp, 'o'), ours);
  fs.writeFileSync(path.join(tmp, 't'), theirs);
  const r = git(
    repo,
    ['merge-file', '-p', flag, path.join(tmp, 'o'), path.join(tmp, 'b'), path.join(tmp, 't')],
    true,
  );
  return r.code >= 0 && r.code < 128 ? r.out : undefined;
}

/** Chain with the resolver: ws-merge → union/linewise → theirs (tagged). */
function chainBestEffort(repo, baseSha, lanes) {
  const tmp = path.join(repo, '.stress-tmp');
  fs.mkdirSync(tmp, { recursive: true });
  let current = baseSha;
  const lossy = [];
  for (const [name, sha] of lanes) {
    const step = mergeStep(repo, ['-X', 'ignore-space-change'], current, sha);
    let tree;
    if (step.conflict) {
      const mergeBase = git(repo, ['merge-base', current, sha], true)
        .out.trim()
        .split('\n')[0];
      const replacements = [];
      let unresolved;
      for (const file of step.conflict) {
        const blobOf = (c) => {
          const r = git(repo, ['rev-parse', '--verify', `${c}:${file}`], true);
          return r.code === 0 ? r.out.trim() : undefined;
        };
        const [b, o, t] = [blobOf(mergeBase), blobOf(current), blobOf(sha)];
        if (!o || !t) {
          unresolved = file;
          break;
        }
        const read = (blob) => git(repo, ['cat-file', 'blob', blob]).out;
        const [bT, oT, tT] = [b ? read(b) : '', read(o), read(t)];
        let content;
        let wasLossy = false;
        if (o === t) content = oT;
        else if ((content = mergeLinewise(bT, oT, tT)) !== undefined);
        else if (b && bothSidesOnlyInsert(bT, oT, tT)) {
          content = mergeFileFlag(repo, tmp, bT, oT, tT, '--union');
        }
        if (content === undefined) {
          content = mergeFileFlag(repo, tmp, bT, oT, tT, '--theirs');
          wasLossy = content !== undefined;
        }
        if (content === undefined) {
          unresolved = file;
          break;
        }
        fs.writeFileSync(path.join(tmp, 'blob'), content);
        const blob = git(repo, ['hash-object', '-w', path.join(tmp, 'blob')]).out.trim();
        replacements.push({ file, blob });
        if (wasLossy) lossy.push(`${name}:${file}`);
      }
      if (unresolved) {
        return { failedLane: name, files: [unresolved] };
      }
      const idx = path.join(tmp, 'index');
      const env = { ...process.env, GIT_INDEX_FILE: idx, GIT_TERMINAL_PROMPT: '0', LANG: 'C' };
      execFileSync('git', ['read-tree', step.tree], { cwd: repo, env });
      for (const r of replacements) {
        execFileSync(
          'git',
          ['update-index', '--add', '--cacheinfo', `100644,${r.blob},${r.file}`],
          { cwd: repo, env },
        );
      }
      tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).trim();
    } else {
      tree = step.tree;
    }
    current = git(repo, [
      'commit-tree',
      tree,
      '-p',
      current,
      '-p',
      sha,
      '-m',
      `integrate ${name}`,
    ]).out.trim();
  }
  return { tip: current, lossy };
}

/** Exact engine semantics: merge-tree pair, commit-tree the result. */
function mergeStep(repo, args, ours, theirs) {
  const r = git(
    repo,
    ['merge-tree', '--write-tree', '--name-only', ...args, ours, theirs],
    true,
  );
  const first = r.out.split('\n')[0]?.trim() ?? '';
  if (r.code === 0) {
    return { tree: first };
  }
  const lines = r.out.split('\n').map((l) => l.trim());
  const files = [];
  for (const line of lines.slice(1)) {
    if (!line) break;
    files.push(line);
  }
  return { conflict: files, tree: first };
}

function chain(repo, args, baseSha, lanes) {
  let current = baseSha;
  for (const [name, sha] of lanes) {
    const step = mergeStep(repo, args, current, sha);
    if (step.conflict) {
      return { failedLane: name, files: step.conflict };
    }
    current = git(repo, [
      'commit-tree',
      step.tree,
      '-p',
      current,
      '-p',
      sha,
      '-m',
      `integrate ${name}`,
    ]).out.trim();
  }
  return { tip: current };
}

function buildRepo(archetype) {
  const repo = path.join(root, archetype.name);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'stress@test']);
  git(repo, ['config', 'user.name', 'stress']);
  writeFiles(repo, BASE_FILES);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  const fork = git(repo, ['rev-parse', 'HEAD']).out.trim();

  const makeLane = (name, mutate) => {
    git(repo, ['checkout', '-q', '-b', name, fork]);
    mutate(repo);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', name]);
    return git(repo, ['rev-parse', 'HEAD']).out.trim();
  };
  const laneA = makeLane('lane-a', archetype.laneA);
  const laneB = makeLane('lane-b', archetype.laneB);

  git(repo, ['checkout', '-q', 'main']);
  if (archetype.base) {
    archetype.base(repo);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base moves']);
  }
  const baseSha = git(repo, ['rev-parse', 'HEAD']).out.trim();
  return { repo, baseSha, laneA, laneB };
}

// ---------------------------------------------------------------------------

function verdictFor(repo, archetype, result, lossy) {
  if (result.failedLane) {
    return `CONFLICT@${result.failedLane}(${result.files.join(',')})`;
  }
  let verdict = 'clean';
  if (archetype.bothSurvive) {
    const [needleA, needleB, file] = archetype.bothSurvive;
    const content = git(repo, ['show', `${result.tip}:${file}`], true).out;
    const hasA = content.includes(needleA);
    const hasB = content.includes(needleB);
    if (!hasA || !hasB) {
      verdict = `clean but LOSSY (missing ${[!hasA && 'A', !hasB && 'B'].filter(Boolean).join('+')})`;
    }
  }
  if (lossy && lossy.length > 0 && verdict === 'clean') {
    verdict = `clean, tagged lossy (${lossy.join(',')})`;
  }
  return verdict;
}

const rows = [];
for (const archetype of ARCHETYPES) {
  const { repo, baseSha, laneA, laneB } = buildRepo(archetype);
  const lanes = [
    ['lane-a', laneA],
    ['lane-b', laneB],
  ];
  const row = { name: archetype.name, petty: archetype.petty, tiers: {} };
  for (const [tier, args] of TIERS) {
    row.tiers[tier] = verdictFor(repo, archetype, chain(repo, args, baseSha, lanes));
  }
  const be = chainBestEffort(repo, baseSha, lanes);
  row.tiers['best-effort'] = verdictFor(repo, archetype, be, be.lossy);
  rows.push(row);
}

const w = Math.max(...rows.map((r) => r.name.length)) + 2;
const COLS = ['off', 'whitespace', 'legacy-lane-wins', 'best-effort'];
console.log(
  `${'archetype'.padEnd(w)}petty  ${COLS.map((c) => c.padEnd(36)).join('')}`,
);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(w)}${String(r.petty).padEnd(7)}${COLS.map((c) => r.tiers[c].padEnd(36)).join('')}`,
  );
}
console.log(`\nfixtures under: ${root}`);
