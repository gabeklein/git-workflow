/**
 * `vscode`, for a process that has none.
 *
 * The rebuild engine is pure git plumbing except for one thing: it reads
 * workspace settings through `vscode.workspace.getConfiguration`. Rather
 * than fork the engine or thread a config object through twenty call
 * sites — both of which would leave two versions of the rules to keep in
 * step — the CLI bundle substitutes this module for `vscode` at build
 * time and serves the same values from `focus-config` (see settings.ts).
 *
 * So the CLI runs the SAME engine the editor runs, byte for byte. That
 * is the property worth protecting: a preview built headlessly and one
 * built from the sidebar must not be able to differ.
 *
 * Only what the git layer actually touches is implemented. Anything else
 * throws on purpose — a silently empty stub would turn a missing
 * capability into a wrong answer somewhere far from here.
 */

let resolve: (key: string) => unknown = () => undefined;

/**
 * Where settings come from. A resolver rather than a snapshot: it is
 * consulted on every read, so the editor rewriting focus-config takes
 * effect immediately, with no snapshot to go stale.
 */
export function resolveConfigurationWith(
  resolver: (key: string) => unknown,
): void {
  resolve = resolver;
}

class Configuration {
  constructor(private readonly section: string) {}

  get<T>(key: string, fallback?: T): T | undefined {
    return (resolve(`${this.section}.${key}`) as T) ?? fallback;
  }
}

export const workspace = {
  getConfiguration(section: string): Configuration {
    return new Configuration(section);
  },
  get workspaceFolders(): undefined {
    return undefined;
  },
  onDidChangeConfiguration(): { dispose(): void } {
    return { dispose() {} };
  },
};

const unavailable = (name: string) => () => {
  throw new Error(`vscode.${name} is not available outside the editor`);
};

export const window = {
  showInformationMessage: unavailable('window.showInformationMessage'),
  showWarningMessage: unavailable('window.showWarningMessage'),
  showErrorMessage: unavailable('window.showErrorMessage'),
  createOutputChannel: unavailable('window.createOutputChannel'),
};

export const commands = { executeCommand: unavailable('commands.executeCommand') };

export class EventEmitter<T> {
  private readonly listeners: ((e: T) => void)[] = [];
  readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {}
}

export const Uri = {
  file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
};
