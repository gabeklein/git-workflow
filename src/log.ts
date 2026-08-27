import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface LineLogger {
  appendLine(value: string): void;
}

/** Always-writable location (survives even when context.logUri is flaky under F5). */
export function stableLogPath(): string {
  return path.join(os.homedir(), '.git-workflow', 'git-workflow.log');
}

/**
 * Mirrors OutputChannel lines to:
 * 1. ~/ .git-workflow/git-workflow.log  (stable, easy to find)
 * 2. context.logUri/git-workflow.log    (VS Code extension log dir, when available)
 *
 * Sync appends so a hard host kill usually still leaves the last lines on disk.
 */
export function createFileBackedLogger(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): LineLogger & { logFile: string; dispose(): void } {
  const stableFile = stableLogPath();
  const logFiles = [stableFile];

  try {
    fs.mkdirSync(path.dirname(stableFile), { recursive: true });
  } catch {
    // ignore
  }

  try {
    const vscodeLog = path.join(context.logUri.fsPath, 'git-workflow.log');
    fs.mkdirSync(context.logUri.fsPath, { recursive: true });
    if (vscodeLog !== stableFile) logFiles.push(vscodeLog);
  } catch {
    // ignore secondary path
  }

  try {
    const globalLog = path.join(
      context.globalStorageUri.fsPath,
      'git-workflow.log',
    );
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    if (!logFiles.includes(globalLog)) logFiles.push(globalLog);
  } catch {
    // ignore
  }

  const header =
    `${'='.repeat(60)}\n` +
    `${new Date().toISOString()} session start\n` +
    `paths=${logFiles.join(' | ')}\n`;

  for (const f of logFiles) {
    try {
      fs.appendFileSync(f, header);
    } catch {
      // ignore
    }
  }

  channel.appendLine(`Durable log (primary): ${stableFile}`);
  for (const f of logFiles.slice(1)) {
    channel.appendLine(`Durable log (also): ${f}`);
  }

  return {
    logFile: stableFile,
    appendLine(value: string): void {
      channel.appendLine(value);
      const line = `${new Date().toISOString()} ${value}\n`;
      for (const f of logFiles) {
        try {
          fs.appendFileSync(f, line);
        } catch {
          // ignore
        }
      }
    },
    dispose(): void {
      const line = `${new Date().toISOString()} session end (dispose)\n`;
      for (const f of logFiles) {
        try {
          fs.appendFileSync(f, line);
        } catch {
          // ignore
        }
      }
    },
  };
}
