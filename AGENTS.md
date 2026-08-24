# Agent instructions — git-workflow

## Testing policy

Every behavior change lands with tests in the same PR. A bug fix adds the
test that would have caught it; a new feature adds coverage for its
happy path and its refusal/edge behavior. If a PR changes what the
extension does and touches no test file, that is a review finding.

There are two layers — pick by what the code needs, not by convenience:

| Layer | Where | Runs | Command |
|---|---|---|---|
| Unit (vitest) | `test/unit/*.test.ts` | plain node, scratch git repos, `vscode` stubbed | `npm run test:unit` (~3s) |
| EDH (mocha) | `test/edh/*.test.ts` | inside a real VS Code Extension Development Host | `npm run test:edh` (~60s) |

- **Pure-git logic** (`src/git/**`: predicates, lane files, merge/rebuild
  plumbing) belongs in the unit layer. Build real repos with
  `test/unit/helpers.ts` — no mocking of git itself.
- **Command/view behavior** (registered commands, tree/panel state via the
  `GW_TEST_HOOKS` api, watcher/event reactions) belongs in the EDH layer.
  Cover both layers when a feature spans them; the unit test pins the
  predicate, the EDH scenario pins the wiring.
- Native modal dialogs cannot be driven in the EDH — keep decision logic
  out of dialog handlers so it stays unit-testable, and test up to the
  dialog boundary.

### EDH suite rules

- Scenarios are **sequential and stateful**: files run in the explicit
  `ORDER` list in `test/edh/index.ts` (never alphabetically) and the run
  bails on first failure. A new file must be added to `ORDER` — the entry
  hard-errors on drift. Later scenarios may depend on earlier state;
  when adding one, place it deliberately and mind what it inherits.
- Group related describes in one file (`overlay`, `landing`, `catch-up`,
  `membership`, `conflicts`); add a new file only for a genuinely new
  area.
- **Poll, never sleep**, for anything asynchronous (`poll()` in
  `test/edh/helpers.ts`). Commands that end in a push offer a
  notification nothing dismisses headlessly — `fire()` them without
  awaiting and poll git state instead.
- The fixture (sample repo + bare origin + `landing` clone standing in
  for the GitHub side) is built by `test/edh/run.mjs`; assert against
  real git state plus the `GW_TEST_HOOKS` view state, not internals.

### Running tests as an agent

- Iterate against `npm run test:unit` — it is fast and windowless.
- `npm run test:edh` opens a **real VS Code window** on macOS (VS Code
  has no headless mode) and steals focus from the user. Run it sparingly:
  once as a final verification before handing work back, not in an edit
  loop. CI runs it headlessly under `xvfb-run` on every PR.
- `npm test` = test typechecks + unit + EDH.

## Git & PRs

- Do not add AI attribution trailers (`Co-authored-by`, sign-offs) to
  commits.
