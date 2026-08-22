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
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined;
  }
  const first = rel.split(path.sep)[0];
  if (!first || first === '.git') {
    return undefined;
  }
  const pattern = `/${first}/`;

  const common = path.resolve(
    parent,
    (await git(parent, ['rev-parse', '--git-common-dir'])).trim(),
  );
  const infoDir = path.join(common, 'info');
  const file = path.join(infoDir, 'exclude');
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    // absent — created below
  }
  const lines = new Set(text.split('\n').map((l) => l.trim()));
  if (
    lines.has(pattern) ||
    lines.has(`${first}/`) ||
    lines.has(`/${first}`) ||
    lines.has(first)
  ) {
    return undefined;
  }
  await fs.mkdir(infoDir, { recursive: true });
  const lead = text && !text.endsWith('\n') ? '\n' : '';
  await fs.writeFile(
    file,
    `${text}${lead}# Git Workflow: keep worktree checkouts out of status\n${pattern}\n`,
  );
  return pattern;
}
