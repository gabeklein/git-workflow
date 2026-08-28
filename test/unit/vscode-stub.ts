/**
 * Minimal `vscode` replacement for unit tests (vitest aliases the module
 * here). Configuration reads fall through to their declared defaults —
 * enough for the pure-git modules under src/git/**, which touch vscode
 * only via workspace.getConfiguration() and workspaceFolders.
 */
interface StubFolder {
  uri: { fsPath: string };
  name: string;
  index: number;
}

export const workspace: {
  workspaceFolders: StubFolder[] | undefined;
  getConfiguration: () => { get<T>(key: string, defaultValue?: T): T | undefined };
} = {
  workspaceFolders: undefined,
  getConfiguration: () => ({
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  }),
};

/** Point discovery at scratch checkouts; call with none to reset. */
export function setWorkspaceFolders(...paths: string[]): void {
  workspace.workspaceFolders = paths.length
    ? paths.map((fsPath, index) => ({
        uri: { fsPath },
        name: fsPath,
        index,
      }))
    : undefined;
}
