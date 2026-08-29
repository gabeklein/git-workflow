import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { revParseCommit } from '../plumbing';
import type { RebuildResult, ResolvedLane } from './engine';
import { commonDir } from './lanes';
import { resolveBaseSha } from './status';

/**
 * The last rebuild's outcome, on disk.
 *
 * Until now a failed rebuild existed in two places, both of them inside a
 * running editor: the Preview row's tooltip and the output channel. An
 * agent — the party most likely to be holding the lane that broke it —
 * could read every `focus-*` file, see its branch listed as applied, and
 * conclude its work was in the preview. It was not: a failed rebuild
 * leaves the checkout untouched, so the tree is the last GOOD one and the
 * offending lane is missing from it. Work debugged against that tree is
 * debugged against a fiction, and the usual next move — brute-forcing a
 * fix for something that never merged — is exactly what this file exists
 * to prevent.
 *
 * Deliberately plain text, one `key: value` per line, in the git common
 * dir with the rest of the lane state: `gw-lane status` prints it with
 * `sed`, so no JSON parser is needed in a POSIX shell, and a human or an
 * agent reading the raw file gets the same words.
 *
 * It is a RECORD, not a source of truth — nothing reads it back to decide
 * anything. The recorded tips are what make it self-invalidating: catch a
 * conflicting lane up with the base and its sha no longer matches, which
 * is how a reader tells "this conflict is current" from "this conflict was
 * already dealt with; rebuild to re-check".
 */
export const STATUS_FILE = 'focus-status';

const HEADER = [
  '# git-workflow: outcome of the last preview rebuild.',
  '# Generated — edit nothing here; it is rewritten on every rebuild.',
  '# Read it with: "$(git rev-parse --git-common-dir)/gw-lane" status',
];

export interface StatusContext {
  /** The derived preview branch, e.g. `preview/main`. */
  branch: string;
  /** What it is built from, e.g. `origin/main`. */
  baseRef: string;
}

/** What to do about each way a rebuild can refuse. */
function nextStep(result: Extract<RebuildResult, { ok: false }>, ctx: StatusContext): string {
  switch (result.code) {
    case 'conflict':
      return `catch ${
        result.lane ?? 'the lane'
      } up with ${ctx.baseRef} (or with the lanes merged before it), then rebuild — do NOT resolve this on ${ctx.branch}`;
    case 'dirty':
      return `the preview checkout has uncommitted edits; absorb them onto a real branch (Absorb Preview Edits) or discard them, then rebuild`;
    case 'unique':
      return `commits exist only on ${ctx.branch}; move them to a lane branch (Absorb Preview Edits) — a rebuild would destroy them`;
    case 'moved':
      return `the preview checkout is not on ${ctx.branch}; switch it back or turn preview mode off`;
    default:
      return 'see Output → Git Workflow for the full error, then rebuild';
  }
}

function degradedLine(r: ResolvedLane): string {
  const parts: string[] = [];
  if (r.lossy.length > 0) parts.push(`lane-wins, hunks dropped in ${r.lossy.join(' ')}`);
  if (r.lossless.length > 0) parts.push(`merged cleanly by rule in ${r.lossless.join(' ')}`);
  return `resolved: ${r.lane} — ${parts.join('; ')}`;
}

/** First value for `key` in a previously written record. */
function field(previous: string | undefined, key: string): string | undefined {
  const line = previous
    ?.split('\n')
    .find((l) => l.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim() || undefined;
}

async function readRaw(cwd: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(await commonDir(cwd), STATUS_FILE), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Record the outcome. Called for every rebuild EXCEPT `busy` — that one
 * means another rebuild owns the state right now, and its result is the
 * one worth recording.
 *
 * Best-effort by contract: a repo where this cannot be written rebuilds
 * exactly as it did before, so every caller ignores the failure.
 */
export async function recordPreviewStatus(
  cwd: string,
  result: RebuildResult,
  ctx: StatusContext,
): Promise<void> {
  const previous = await readRaw(cwd);
  const lines = [...HEADER, `updated: ${new Date().toISOString()}`];
  lines.push(`preview: ${ctx.branch}`);

  const baseSha = await resolveBaseSha(cwd, ctx.baseRef).catch(() => undefined);
  lines.push(`base: ${ctx.baseRef}${baseSha ? ` ${baseSha}` : ''}`);

  if (result.ok) {
    lines.push('state: ok');
    lines.push(`tree: ${result.lanes.length > 0 ? result.lanes.join(', ') : '(base only)'}`);
    // The checkout was just reset onto this chain, so the tree IS the list
    // above. On a failure it is not, which is the whole point of the flag.
    lines.push('tree-current: yes');
    if (result.skipped.length > 0) lines.push(`skipped: ${result.skipped.join(', ')}`);
    if (result.landed.length > 0) lines.push(`landed: ${result.landed.join(', ')}`);
    for (const r of result.resolved) lines.push(degradedLine(r));
    if (result.resolved.some((r) => r.lossy.length > 0)) {
      lines.push(
        'next: the preview dropped clashing hunks to keep building — review those files before trusting them',
      );
    }
    for (const lane of result.lanes) {
      const sha = await revParseCommit(cwd, `refs/heads/${lane}`).catch(() => undefined);
      if (sha) lines.push(`tip: ${lane} ${sha}`);
    }
  } else {
    lines.push('state: failed');
    lines.push(`code: ${result.code}`);
    if (result.lane) lines.push(`lane: ${result.lane}`);
    lines.push(`detail: ${result.message.replace(/\s+/g, ' ')}`);
    // A refused rebuild never touches the checkout, so the tree is still
    // whatever the last good one produced — carried forward rather than
    // recomputed, because there is nothing new to compute. Minus the lane
    // that just failed: a good build may well have held an OLDER tip of
    // it, and listing the name would contradict `missing-from-tree` on the
    // next line for the only reader who matters, the one holding it.
    const carried = (field(previous, 'tree') ?? '')
      .split(',')
      .map((l) => l.trim())
      .filter((l) => l && l !== '(base only)' && l !== result.lane);
    lines.push(
      `tree: ${
        field(previous, 'tree') === undefined
          ? '(unknown — no successful rebuild recorded)'
          : carried.join(', ') || '(base only)'
      }`,
    );
    lines.push('tree-current: no');
    if (result.lane) {
      lines.push(
        `missing-from-tree: ${result.lane} (at least its newest commits) and every lane merged after it`,
      );
    }
    lines.push(`next: ${nextStep(result, ctx)}`);
    if (result.lane) {
      const sha = await revParseCommit(cwd, `refs/heads/${result.lane}`).catch(
        () => undefined,
      );
      if (sha) lines.push(`tip: ${result.lane} ${sha}`);
    }
  }

  await fs.writeFile(
    path.join(await commonDir(cwd), STATUS_FILE),
    `${lines.join('\n')}\n`,
  );
}

/**
 * Drop the record — preview going off. A conflict left behind would
 * otherwise still be sitting there describing a preview that no longer
 * exists, which is worse than saying nothing.
 */
export async function clearPreviewStatus(cwd: string): Promise<void> {
  await fs
    .rm(path.join(await commonDir(cwd), STATUS_FILE), { force: true })
    .catch(() => {});
}

/** The raw record, for tests and anything that wants to show it. */
export async function readPreviewStatus(cwd: string): Promise<string | undefined> {
  return readRaw(cwd);
}
