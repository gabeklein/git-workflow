import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { worktreeTerminalSpec } from '../../src/commands/worktreeTerminal';

describe('worktreeTerminalSpec', () => {
  it('names the terminal after the branch', () => {
    expect(worktreeTerminalSpec('/repo/.worktrees/feat-a', 'feat/a')).toEqual({
      name: 'Git Workflow: feat/a',
      cwd: path.normalize('/repo/.worktrees/feat-a'),
    });
  });

  it('falls back to the directory basename when there is no branch', () => {
    const cwd = path.normalize('/repo/.worktrees/feat-a');
    expect(worktreeTerminalSpec(cwd)).toEqual({
      name: 'Git Workflow: feat-a',
      cwd,
    });
    expect(worktreeTerminalSpec(cwd, '  ')).toEqual({
      name: 'Git Workflow: feat-a',
      cwd,
    });
  });

  it('refuses an empty path', () => {
    expect(worktreeTerminalSpec('')).toBeUndefined();
    expect(worktreeTerminalSpec('   ')).toBeUndefined();
  });
});
