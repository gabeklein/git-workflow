/**
 * Shared plumbing for the EDH scenario files. Everything here runs INSIDE
 * the Extension Development Host (see scripts/edh-test/run.mjs for the
 * boot + fixture setup). Files are bundled independently, so this module
 * keeps no cross-file state beyond the idempotent extension activation.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const repo = process.env.GW_FIXTURE_REPO as string;
export const landing = process.env.GW_FIXTURE_LANDING as string;
export const laneA = path.join(repo, '.worktrees', 'feat-a');
export const laneB = path.join(repo, '.worktrees', 'feat-b');
/**
 * The preview tree — the SAME directory as `repo`, because the preview is
 * the root checkout and nothing else. Named separately where a scenario
 * means "the derived tree" rather than "the repository".
 */
export const previewRoot = repo;
/**
 * The BASE's checkout. It needs one of its own now that the root is the
 * preview: absorb moves work into it, and a commit on local main (base
 * drift) has to be made somewhere.
 */
export const mainTree = path.join(repo, '.worktrees', 'main');

/** View-state hooks exported by activate() under GW_TEST_HOOKS. */
export interface TestApi {
  preview(): {
    lanes: string[];
    candidates: string[];
    landed: string[];
    autoResolved: { lane: string; lossless: string[]; lossy: string[] }[];
    baseDrift?: {
      ahead: number;
      sha: string;
      resetTo: string;
      included: boolean;
    };
    error?: unknown;
  } | undefined;
  setBaseDriftIncluded(included: boolean): Promise<unknown>;
  /** Directory-section rows for the focused worktree, read through the
   *  Changes panel (pass a folder's relative path to descend). Rows: kind,
   *  label, absolute path. */
  explorerChildren(folderRelPath?: string): Promise<{
    kind: string;
    label: string;
    path?: string;
  }[]>;
  /** Top-level Changes rows, in render order. */
  changesRows(): Promise<{ kind: string; label: string }[]>;
  /** The RENDERED Lanes panel rows; pass a group to list its children. */
  focusRows(group?: 'working' | 'local' | 'remote' | 'landed'): Promise<
    {
      kind?: string;
      group?: string;
      label: string;
      description: string;
      contextValue?: string;
    }[]
  >;
  /**
   * The RENDERED lane rows under the preview row (what VS Code actually
   * paints). Read through the Lanes tree — preview row → lanes — so a
   * preview that stopped rendering fails here instead of passing on a
   * provider nothing draws.
   */
  previewRows(): Promise<
    {
      kind?: string;
      label: string;
      description: string;
      contextValue?: string;
      checkbox?: boolean;
    }[]
  >;
  selectedPath(): string | undefined;
  /** isDirty is what the rows carry; scenarios that assert on it are
   *  asserting that discovery reran, not just that a view repainted. */
  worktrees(): { path: string; branch: string; isDirty?: boolean }[];
  baseStatus(worktreePath: string): {
    behind: number;
    conflicts: boolean;
    rebasing?: boolean;
    merging?: boolean;
  } | undefined;
  refreshBaseStatuses(): Promise<void>;
  logFile(): string;
}

let api: TestApi | undefined;

export async function getApi(): Promise<TestApi> {
  if (!api) {
    const ext = vscode.extensions.getExtension('local.git-workflow');
    if (!ext)
      throw new Error('extension local.git-workflow is not present in the EDH');
    const exported = await ext.activate();
    api = exported?.test as TestApi | undefined;
    if (!api) throw new Error('test hooks not exported (GW_TEST_HOOKS)');
  }
  return api;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export function readLanes(file: string): string[] {
  try {
    return fs
      .readFileSync(path.join(repo, '.git', file), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

export const applied = (): string[] => readLanes('focus-applied');

export async function poll(
  desc: string,
  timeoutMs: number,
  fn: () => boolean | Promise<boolean>,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) {
      console.log(`      · ${desc} (${Date.now() - t0}ms)`);
      return;
    }
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`TIMEOUT after ${timeoutMs}ms: ${desc}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Run the lane CLI, waiting out a rebuild lock somebody else holds.
 *
 * The editor is a competing writer, and in CI it is a busy one: discovery,
 * an auto-rebuild and this command can all want the lock inside the same
 * second. Exit 2 with "busy" is the CLI answering CORRECTLY — the lock is
 * doing its job — so a scenario that lets it throw is asserting a
 * quiescence CI does not owe us. The sibling case in shell.test.ts learned
 * this for `owner` and polls; every other call learned it the hard way, as
 * a run that failed on a lane the editor happened to be rebuilding.
 *
 * Anything else still throws on the first try: a real refusal is not
 * something to wait out.
 */
export async function lane(
  args: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const cli = path.join(repo, '.git', 'gw-lane');
  const t0 = Date.now();
  for (;;) {
    try {
      return execFileSync(cli, args, { cwd: repo, encoding: 'utf8' });
    } catch (err) {
      const e = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const said = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`;
      const busy = e.status === 2 && /rebuild lock held/.test(said);
      if (!busy || Date.now() - t0 > timeoutMs) throw err;
      await sleep(400);
    }
  }
}

/** Commands ending in a push OFFER await a notification nothing dismisses
 *  in a headless workbench — fire without awaiting and poll git state. */
export function fire(command: string, arg?: unknown): void {
  void vscode.commands.executeCommand(command, arg);
}

export async function run(
  command: string,
  ...args: unknown[]
): Promise<void> {
  await vscode.commands.executeCommand(command, ...args);
}
