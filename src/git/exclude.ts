import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { git } from './exec';

/**
 * Keep in-repo worktree checkouts out of `git status`: append the
 * containing folder (e.g. `/.worktrees/`) to `.git/info/exclude` —
 * repo-local ignore that is never committed, so no gitignore ceremony.
 *
 * No-op when the destination is outside the surrounding repo's working
 * tree (sibling-directory layouts need no ignoring), or when an
 * equivalent pattern is already present. Returns the pattern added.
 */
export async function ensureExcludedFromStatus(
  destDir: string,
): Promise<string | undefined> {
  const parent = path.dirname(path.resolve(destDir));
  // Which repo (if any) contains the destination?
  const top = path.normalize(
    (await git(parent, ['rev-parse', '--show-toplevel'])).trim(),
  );
  const rel = path.relative(top, path.resolve(destDir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const relPosix = rel.split(path.sep).join('/');
  if (relPosix === '.git' || relPosix.startsWith('.git/')) return undefined;
  // Exclude the containing folder (dedicated to checkouts); a checkout
  // sitting directly at the repo root excludes just itself.
  const parentRel = path.posix.dirname(relPosix);
  const target = parentRel === '.' ? relPosix : parentRel;
  const pattern = `/${target}/`;

  const common = path.resolve(
    parent,
    (await git(parent, ['rev-parse', '--git-common-dir'])).trim(),
  );
  const lines = new Set(
    (await read(path.join(common, 'info', 'exclude')))
      .split('\n')
      .map((l) => l.trim()),
  );
  if (
    lines.has(pattern) ||
    lines.has(`${target}/`) ||
    lines.has(`/${target}`) ||
    lines.has(target)
  ) {
    return undefined;
  }
  await appendExclude(
    common,
    '# Git Workflow: keep worktree checkouts out of status',
    [pattern],
  );
  return pattern;
}

/** Append patterns under a comment header, creating the file if absent. */
async function appendExclude(
  common: string,
  comment: string,
  patterns: string[],
): Promise<void> {
  const infoDir = path.join(common, 'info');
  const file = path.join(infoDir, 'exclude');
  const text = await read(file);
  const have = new Set(text.split('\n').map((l) => l.trim()));
  const add = patterns.filter((p) => !have.has(p));
  if (add.length === 0) return;
  await fs.mkdir(infoDir, { recursive: true });
  const lead = text && !text.endsWith('\n') ? '\n' : '';
  const header = have.has(comment) ? '' : `${comment}\n`;
  await fs.writeFile(file, `${text}${lead}${header}${add.join('\n')}\n`);
}

/**
 * Files the extension writes normally live in `.git`, where git never sees
 * them. A repo that points `core.hooksPath` at a directory INSIDE the
 * working tree (husky and friends) drags them into `git status` instead —
 * and the user gets untracked files they did not create and must not
 * commit.
 *
 * So ignore them the same way worktree checkouts are ignored: repo-local
 * `.git/info/exclude`, which is never committed, so nothing is asked of the
 * project's own `.gitignore`. Only paths we actually wrote are listed, so a
 * project that later commits real hooks alongside them is unaffected
 * (exclude patterns do not apply to tracked files either way).
 *
 * No-op for anything outside a working tree — the ordinary `.git/hooks`
 * case reaches here and correctly does nothing.
 */
export async function excludeManagedFiles(files: string[]): Promise<string[]> {
  const patterns: string[] = [];
  let common: string | undefined;
  for (const abs of files) {
    const where = await locate(abs);
    if (!where) continue;
    common = where.common;
    patterns.push(where.pattern);
  }
  if (!common || patterns.length === 0) return [];
  await appendExclude(
    common,
    '# Git Workflow: files it manages inside the working tree',
    patterns,
  );
  return patterns;
}

/** Drop the lines `excludeManagedFiles` added for `files`. */
export async function unexcludeManagedFiles(files: string[]): Promise<void> {
  const drop = new Set<string>();
  let common: string | undefined;
  for (const abs of files) {
    const where = await locate(abs);
    if (!where) continue;
    common = where.common;
    drop.add(where.pattern);
  }
  if (!common || drop.size === 0) return;
  const file = path.join(common, 'info', 'exclude');
  const text = await read(file);
  if (!text) return;
  const kept = text.split('\n').filter((l) => !drop.has(l.trim()));
  // A header left with nothing under it is litter — take it out too.
  const header = '# Git Workflow: files it manages inside the working tree';
  const at = kept.indexOf(header);
  const next = kept[at + 1]?.trim();
  if (at >= 0 && (next === undefined || next === '' || next.startsWith('#')))
    kept.splice(at, 1);
  const out = kept.join('\n');
  if (out !== text) await fs.writeFile(file, out);
}

/**
 * Where `abs` sits: its pattern relative to the containing working tree,
 * and the common dir whose `info/exclude` governs it. Undefined when the
 * path is outside a working tree, or inside `.git` (already invisible).
 */
async function locate(
  abs: string,
): Promise<{ pattern: string; common: string } | undefined> {
  const dir = path.dirname(path.resolve(abs));
  try {
    const top = path.normalize(
      (await git(dir, ['rev-parse', '--show-toplevel'])).trim(),
    );
    const rel = path.relative(top, path.resolve(abs));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const relPosix = rel.split(path.sep).join('/');
    if (relPosix === '.git' || relPosix.startsWith('.git/')) return undefined;
    const common = path.resolve(
      dir,
      (await git(dir, ['rev-parse', '--git-common-dir'])).trim(),
    );
    return { pattern: `/${relPosix}`, common };
  } catch {
    return undefined;
  }
}

async function read(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}
