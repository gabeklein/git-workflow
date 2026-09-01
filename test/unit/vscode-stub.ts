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

/** Settings a test has overridden, by bare key (e.g. githubPrRefreshMs). */
const overrides = new Map<string, unknown>();

export const workspace: {
  workspaceFolders: StubFolder[] | undefined;
  getConfiguration: () => { get<T>(key: string, defaultValue?: T): T | undefined };
} = {
  workspaceFolders: undefined,
  getConfiguration: () => ({
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      overrides.has(key) ? (overrides.get(key) as T) : defaultValue,
  }),
};

/** Override declared defaults for one test; call with none to reset. */
export function setConfig(values: Record<string, unknown> = {}): void {
  overrides.clear();
  for (const [k, v] of Object.entries(values)) overrides.set(k, v);
}

/** Window focus gates network work in the PR index; tests drive it here. */
export const window: { state: { focused: boolean } } = {
  state: { focused: true },
};

export function setWindowFocused(focused: boolean): void {
  window.state.focused = focused;
}

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
