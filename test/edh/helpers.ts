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
export const working = path.join(repo, '.worktrees', 'working');

/** View-state hooks exported by activate() under GW_TEST_HOOKS. */
export interface TestApi {
  integration(): {
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
   * The RENDERED lane rows under Preview (what VS Code actually paints).
   * Async now: they are read through the Lanes tree, group → preview → lanes,
   * so a preview that stopped rendering fails here instead of passing on a
   * provider nothing draws.
   */
  integrationRows(): Promise<
    {
      kind?: string;
      label: string;
      description: string;
      contextValue?: string;
      checkbox?: boolean;
    }[]
  >;
  selectedPath(): string | undefined;
  worktrees(): { path: string; branch: string }[];
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
    if (!ext) {
      throw new Error('extension local.git-workflow is not present in the EDH');
    }
    const exported = await ext.activate();
    api = exported?.test as TestApi | undefined;
    if (!api) {
      throw new Error('test hooks not exported (GW_TEST_HOOKS)');
    }
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
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`TIMEOUT after ${timeoutMs}ms: ${desc}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

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
