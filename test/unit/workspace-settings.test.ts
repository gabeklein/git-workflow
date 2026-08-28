import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  excludeWorkspaceSettings,
  unexcludeWorkspaceSettings,
} from '../../src/git/exclude';
import { isWorktreeDirty } from '../../src/git/plumbing';
import { git, makeRepo, type ScratchRepo } from './helpers';

/**
 * With preview mode on, the preview IS the workspace root — so VS Code's
 * `.vscode/settings.json` is written inside a derived checkout. Untracked,
 * that one file is enough to make `isWorktreeDirty` true and every rebuild
 * refuse ("preview checkout is dirty"), which the extension triggers on
 * itself: Change Preview Base writes a workspace-scoped setting.
 */
describe('workspace settings in the preview tree', () => {
  let scratch: ScratchRepo;
  const settings = () => path.join(scratch.repo, '.vscode', 'settings.json');

  const writeSettings = (body: string) => {
    fs.mkdirSync(path.dirname(settings()), { recursive: true });
    fs.writeFileSync(settings(), body);
  };

  beforeEach(() => {
    scratch = makeRepo();
  });
  afterEach(() => {
    scratch.cleanup();
  });

  it('excludes it BEFORE it exists — the order preview mode enables in', async () => {
    // `.vscode/` is typically absent when preview mode is turned on, and
    // resolving the pattern from the missing directory wrote no exclude
    // line at all: every rebuild then refused as dirty the moment VS Code
    // saved a workspace setting.
    expect(fs.existsSync(path.dirname(settings()))).toBe(false);
    expect(await excludeWorkspaceSettings(scratch.repo)).toEqual([
      '/.vscode/settings.json',
    ]);
    writeSettings('{ "worktreeCompare.previewBaseRef": "origin/main" }\n');
    expect(await isWorktreeDirty(scratch.repo)).toBe(false);
  });

  it('an untracked settings file would otherwise dirty the preview', async () => {
    writeSettings('{ "worktreeCompare.previewBaseRef": "origin/main" }\n');
    // The regression this exists for
    expect(await isWorktreeDirty(scratch.repo)).toBe(true);

    expect(await excludeWorkspaceSettings(scratch.repo)).toEqual([
      '/.vscode/settings.json',
    ]);
    expect(await isWorktreeDirty(scratch.repo)).toBe(false);
  });

  it('leaves the rest of .vscode visible — only that one file is ours', async () => {
    writeSettings('{}\n');
    await excludeWorkspaceSettings(scratch.repo);
    fs.writeFileSync(
      path.join(scratch.repo, '.vscode', 'launch.json'),
      '{ "configurations": [] }\n',
    );
    expect(await isWorktreeDirty(scratch.repo)).toBe(true);
    // -uall: the default collapses an untracked directory to `?? .vscode/`,
    // which would pass this assertion without proving which file is visible.
    expect(git(scratch.repo, ['status', '--porcelain', '-uall'])).toBe(
      '?? .vscode/launch.json',
    );
  });

  it('does NOT hide a settings file the repo tracks', async () => {
    // Exclude patterns never apply to tracked paths, so a project that
    // commits its settings keeps the honest behaviour: an edit there is a
    // real edit in the preview tree, refused and absorbable like any other.
    writeSettings('{ "editor.tabSize": 2 }\n');
    git(scratch.repo, ['add', '-A']);
    git(scratch.repo, ['commit', '-qm', 'track settings']);
    await excludeWorkspaceSettings(scratch.repo);
    writeSettings('{ "editor.tabSize": 4 }\n');
    expect(await isWorktreeDirty(scratch.repo)).toBe(true);
    expect(git(scratch.repo, ['status', '--porcelain'])).toBe(
      'M .vscode/settings.json',
    );
  });

  it('is undone when preview mode goes off', async () => {
    writeSettings('{}\n');
    await excludeWorkspaceSettings(scratch.repo);
    await unexcludeWorkspaceSettings(scratch.repo);
    expect(await isWorktreeDirty(scratch.repo)).toBe(true);
    // and the header it added is not left behind over nothing
    const exclude = fs.readFileSync(
      path.join(scratch.repo, '.git', 'info', 'exclude'),
      'utf8',
    );
    expect(exclude).not.toContain('Git Workflow');
  });
});
