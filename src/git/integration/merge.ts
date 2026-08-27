import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { git, GitError } from '../exec';
import { autoResolveArgs } from './config';

export async function mergeOffTree(
  cwd: string,
  ours: string,
  theirs: string,
  opts?: {
    strict?: boolean;
    /** Explicit merge base — gives cherry-pick semantics (replay THEIRS
     *  relative to this) instead of the common ancestor of ours/theirs. */
    mergeBase?: string;
  },
): Promise<
  | { kind: 'tree'; tree: string }
  | { kind: 'conflict'; files: string[]; tree: string }
  | { kind: 'unsupported' }
> {
  try {
    const out = await git(cwd, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      // strict: decisions (like landed detection) must not vary with the
      // user's auto-resolve preference
      ...(opts?.strict ? [] : autoResolveArgs()),
      ...(opts?.mergeBase ? [`--merge-base=${opts.mergeBase}`] : []),
      ours,
      theirs,
    ]);
    return { kind: 'tree', tree: out.trim().split('\n')[0]!.trim() };
  } catch (err) {
    if (err instanceof GitError) {
      // Exit 1 = clean run, conflicts found. Stdout sections are separated
      // by a blank line: oid, conflicted file names, informational messages.
      if (err.code === 1 && err.stdout.trim()) {
        const lines = err.stdout.split('\n').map((l) => l.trim());
        const files: string[] = [];
        for (const line of lines.slice(1)) {
          if (!line) break;
          files.push(line);
        }
        // Line 1 is still a real tree: the merge with conflicts
        // materialized (markers) — the resolver rewrites it per file.
        return { kind: 'conflict', files, tree: lines[0]! };
      }
      if (
        err.stderr.includes('usage:') ||
        err.stderr.includes('--write-tree') ||
        err.code === 129
      ) {
        return { kind: 'unsupported' };
      }
    }
    throw err;
  }
}

/**
 * Rebuild the integration checkout: compute base + `--no-ff`-style merge
 * of each applied lane off-tree, then apply the result with one
 * `reset --hard`. Refuses when the checkout is dirty or carries commits
 * that belong to no lane. A conflicting lane fails the rebuild WITHOUT
 * touching the working tree.
 */

export interface ResolvedConflicts {
  tree: string;
  /** Files resolved by a LOSSLESS rule (union insert / linewise 3-way). */
  lossless: string[];
  /** Files resolved toward the lane (--theirs) — a hunk was dropped. */
  lossy: string[];
}

/**
 * Per-file conflict resolution for a conflicted off-tree merge — the
 * "petty conflict" killer. For each conflicted file the three blob
 * versions (merge-base / ours / theirs) are resolved in order:
 *
 *  1. identical sides — take either;
 *  2. UNION when both sides only INSERT lines (changelog appends, import
 *     lists, same-point inserts) — keeps both, provably lossless;
 *  3. linewise 3-way when all three versions have the same line count
 *     (adjacent-line edits) — per line, the changed side wins; lossless
 *     unless both changed the same line;
 *  4. mode 'full' only: content-level `merge-file --theirs` — the lane's
 *     hunk wins, the other side's clashing hunk is DROPPED and the file
 *     is reported as lossy so the UI can say so.
 *
 * Anything else (delete-vs-edit, missing sides) stays a real conflict.
 * This pipeline is also the seam for a future AI resolver (one-shot
 * `claude -p` over the three versions) between rules 3 and 4.
 */
export async function resolveConflictedTree(
  cwd: string,
  ours: string,
  theirs: string,
  conflictTree: string,
  files: string[],
  mode: 'lossless' | 'full',
): Promise<ResolvedConflicts | { unresolved: string[] }> {
  const mergeBase = (
    await git(cwd, ['merge-base', ours, theirs]).catch(() => '')
  )
    .trim()
    .split('\n')[0];

  const blobAt = async (commit: string, file: string) => {
    if (!commit) return undefined;
    try {
      return (
        await git(cwd, ['rev-parse', '--verify', `${commit}:${file}`])
      ).trim();
    } catch {
      return undefined;
    }
  };
  const blobContent = async (blob: string) => git(cwd, ['cat-file', 'blob', blob]);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gw-resolve-'));
  const unresolved: string[] = [];
  const lossless: string[] = [];
  const lossy: string[] = [];
  const replacements: { file: string; blob: string; fileMode: string }[] = [];
  try {
    for (const file of files) {
      const [b, o, t] = await Promise.all([
        blobAt(mergeBase ?? '', file),
        blobAt(ours, file),
        blobAt(theirs, file),
      ]);
      if (!o || !t) {
        // Delete-vs-edit / missing side — not a content conflict
        unresolved.push(file);
        continue;
      }
      // Executable bit follows the integration side
      let fileMode = '100644';
      try {
        const ls = await git(cwd, ['ls-tree', ours, '--', file]);
        fileMode = ls.trim().split(/\s+/)[0] || '100644';
      } catch {
        // keep default
      }

      if (o === t) {
        replacements.push({ file, blob: o, fileMode });
        lossless.push(file);
        continue;
      }
      const [bText, oText, tText] = await Promise.all([
        b ? blobContent(b) : Promise.resolve(''),
        blobContent(o),
        blobContent(t),
      ]);
      const write = async (content: string, wasLossy: boolean) => {
        const src = path.join(tmp, 'blob');
        await fs.writeFile(src, content);
        const blob = (await git(cwd, ['hash-object', '-w', src])).trim();
        replacements.push({ file, blob, fileMode });
        (wasLossy ? lossy : lossless).push(file);
      };

      const linewise = mergeLinewise(bText, oText, tText);
      if (linewise !== undefined) {
        await write(linewise, false);
        continue;
      }
      if (b && bothSidesOnlyInsert(bText, oText, tText)) {
        const union = await mergeFile(cwd, tmp, bText, oText, tText, '--union');
        if (union !== undefined) {
          await write(union, false);
          continue;
        }
      }
      if (mode === 'full') {
        const theirsWins = await mergeFile(
          cwd,
          tmp,
          bText,
          oText,
          tText,
          '--theirs',
        );
        if (theirsWins !== undefined) {
          await write(theirsWins, true);
          continue;
        }
      }
      unresolved.push(file);
    }
    if (unresolved.length > 0) return { unresolved };
    // Rewrite the conflicted tree: replace each marker file with its
    // resolved blob via a temp index — no working tree involved.
    const indexFile = path.join(tmp, 'index');
    const env = { GIT_INDEX_FILE: indexFile };
    await git(cwd, ['read-tree', conflictTree], env);
    for (const r of replacements) {
      await git(
        cwd,
        [
          'update-index',
          '--add',
          '--cacheinfo',
          `${r.fileMode},${r.blob},${r.file}`,
        ],
        env,
      );
    }
    const tree = (await git(cwd, ['write-tree'], env)).trim();
    return { tree, lossless, lossy };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Both sides contain every base line in order — they only added lines. */
function bothSidesOnlyInsert(base: string, ours: string, theirs: string) {
  const b = base.split('\n');
  const isSuperset = (side: string) => {
    const lines = side.split('\n');
    let i = 0;
    for (const line of lines) {
      if (i < b.length && line === b[i]) i++;
    }
    return i === b.length;
  };
  return isSuperset(ours) && isSuperset(theirs);
}

/**
 * Same line count on all three sides: merge per line, the changed side
 * wins. undefined when counts differ or both changed the same line.
 */
function mergeLinewise(
  base: string,
  ours: string,
  theirs: string,
): string | undefined {
  const b = base.split('\n');
  const o = ours.split('\n');
  const t = theirs.split('\n');
  if (b.length !== o.length || b.length !== t.length) return undefined;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) {
    if (o[i] === t[i]) {
      out.push(o[i]!);
    } else if (o[i] === b[i]) {
      out.push(t[i]!);
    } else if (t[i] === b[i]) {
      out.push(o[i]!);
    } else {
      return undefined;
    }
  }
  return out.join('\n');
}

/** `git merge-file -p <flag>` over temp files; undefined on hard failure. */
async function mergeFile(
  cwd: string,
  tmp: string,
  base: string,
  ours: string,
  theirs: string,
  flag: '--union' | '--theirs',
): Promise<string | undefined> {
  const bp = path.join(tmp, 'base');
  const op = path.join(tmp, 'ours');
  const tp = path.join(tmp, 'theirs');
  await Promise.all([
    fs.writeFile(bp, base),
    fs.writeFile(op, ours),
    fs.writeFile(tp, theirs),
  ]);
  try {
    return await git(cwd, ['merge-file', '-p', flag, op, bp, tp]);
  } catch (err) {
    // Exit code = number of conflict hunks; with --union/--theirs the
    // content is still fully resolved on stdout. Negative/128+ = error.
    if (err instanceof GitError && err.code !== null && err.code > 0 && err.code < 128)
      return err.stdout;
    return undefined;
  }
}
