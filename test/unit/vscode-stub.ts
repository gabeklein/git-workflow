/**
 * Minimal `vscode` replacement for unit tests (vitest aliases the module
 * here). Configuration reads fall through to their declared defaults —
 * enough for the pure-git modules under src/git/**, which touch vscode
 * only via workspace.getConfiguration().
 */
export const workspace = {
  getConfiguration: () => ({
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  }),
};
