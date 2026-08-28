# Agent instructions — git-workflow

This repo develops the Git Workflow extension **and uses it**: there are linked
worktrees under `.worktrees/`, integration mode may be on, and a `pre-commit`
hook will refuse a commit made on the derived integration branch. The rules are
not hypothetical here, so they are imported rather than linked — read them
before your first edit, not at commit time:

@skills/git-workflow/SKILL.md

The three that cost the most to learn by accident: pick the worktree **before
you write** (writing into the root checkout moves the base branch every other
lane is measured against), never commit on the integration branch and never
`--no-verify` past the guard, and never hand-edit `focus-*` — use `gw-lane`.

## Shipping a feature

A feature is not finished when it works. This extension is increasingly used by
agents that will never read its source, so shipping one means asking what an
agent must know to use it, and putting that where it will be found rather than
where it is easy to write:

- the **skill** (`skills/git-workflow/SKILL.md`) for a rule an agent must
  follow in any repo;
- a **refusal or error message** for a rule it will only meet by breaking it —
  the commit guard is the model: it names the exits, including where to learn
  the workflow;
- **README.md** for what the extension does;
- **AGENTS.md** (here) for what is true only when working *on* the extension.

A change to workflow behavior that updates none of these is unfinished, and it
is the recurring way features land without being adopted.

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
- **Run only what you are working on:** `GW_EDH_ONLY=focus npm run
  test:edh` runs the ORDER *prefix* up to and including that scenario and
  skips the tail — often seconds instead of a minute. A prefix rather than
  the file alone, because scenarios inherit each other's state and one run
  in isolation fails for reasons unrelated to the code under test.
  Regressions in the skipped tail are CI's job, not the edit loop's.
- `npm test` = test typechecks + unit + EDH.
- **A fresh worktree has no `node_modules`.** The install lives once at the
  repo root; worktrees reach it with an untracked symlink, which is the
  first thing to make when tests cannot find `vitest`:

  ```sh
  ln -s ../../node_modules node_modules   # from inside .worktrees/<lane>
  ```

  It is deliberately not tracked. `../../node_modules` is right from a
  worktree and wrong from the repo root, so committing it replaces the one
  real install with a link into the parent directory.

## Git & PRs

- Do not add AI attribution trailers (`Co-authored-by`, sign-offs) to
  commits.

## Working in a repo with integration on

The **integration** branch (default `integration/{base}`) is a derived
preview: the base with each applied lane merged on top, rebuilt with
`reset --hard`. It is not a place work can live — commit on a real
branch instead. A `pre-commit` hook refuses commits made there.

A worktree you create off the integration base becomes a **candidate**
automatically: it shows as an unchecked row, and nothing of yours is
merged into anyone's preview. Joining is deliberate, and it is yours to
decide — you know whether your work is ready to be seen next to the
other lanes, and a base match does not.

To opt in, once the work is worth previewing:

```sh
# works with VS Code closed; installed while integration is on
"$(git rev-parse --git-common-dir)/gw-lane" add          # current branch
"$(git rev-parse --git-common-dir)/gw-lane" status       # what is in the preview
"$(git rev-parse --git-common-dir)/gw-lane" remove       # take it back out
```

Inside the editor the same thing is **Git Workflow: Add to Integration**
(`worktreeCompare.addToIntegration`).

The full rules are the skill in
[`skills/git-workflow`](skills/git-workflow/SKILL.md) — **load it before your
first edit**, not at commit time, since by then the work is already in whatever
checkout you were standing in. It is the same document the commit guard points
other repos at, and it self-checks which of its rules apply. This repo is
usually at its top tier: worktrees under `.worktrees/`, integration sometimes
on, the guard installed.

When the workflow changes, the skill changes with it — it is what agents in
other repos will be reading, and a stale copy is worse than none.

Leave it out when the branch is mid-refactor, deliberately broken, or
exploring something that would clash with other lanes. Being out costs
nothing — the row stays visible and one click away.
