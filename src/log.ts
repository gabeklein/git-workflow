import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface LineLogger {
  appendLine(value: string): void;
}

/**
 * Mirrors OutputChannel lines to a durable file under the extension log dir.
 * Uses sync append so a hard host kill still usually leaves the last lines on disk.
 */
export function createFileBackedLogger(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): LineLogger & { logFile: string; dispose(): void } {
  const logDir = context.logUri.fsPath;
  const logFile = path.join(logDir, 'git-workflow.log');

  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // best-effort
  }

  const header = `${'='.repeat(60)}\n${new Date().toISOString()} session start\nlogFile=${logFile}\n`;
  try {
    fs.appendFileSync(logFile, header);
  } catch {
    // ignore
  }

  channel.appendLine(`Durable log file: ${logFile}`);

  return {
    logFile,
    appendLine(value: string): void {
      channel.appendLine(value);
      try {
        fs.appendFileSync(logFile, `${new Date().toISOString()} ${value}\n`);
      } catch {
        // ignore
      }
    },
    dispose(): void {
      try {
        fs.appendFileSync(
          logFile,
          `${new Date().toISOString()} session end (dispose)\n`,
        );
      } catch {
        // ignore
      }
    },
  };
}
