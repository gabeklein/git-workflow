# Agent instructions — git-workflow

This repo develops the Git Workflow extension **and uses it**: there are linked
worktrees under `.worktrees/`, preview mode may be on, and a `pre-commit`
hook will refuse a commit made on the derived preview branch. The rules are
not hypothetical here, so they are imported rather than linked — read them
before your first edit, not at commit time:

@skills/git-workflow/SKILL.md

The three that cost the most to learn by accident: pick the worktree **before
you write** (with preview on the root checkout IS the preview, rebuilt with
`reset --hard`; with it off the root sits on the base, so writing there moves
the branch every other lane is measured against), never commit on the preview
branch and never `--no-verify` past the guard, and never hand-edit `focus-*` —
use `gw-lane`.

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
- **A fresh worktree has no `node_modules`.** Either works: `npm install`
  inside the lane, or reach the root's install with an untracked symlink,
  which is what makes tests runnable without a second copy:

  ```sh
  ln -s ../../node_modules node_modules   # from inside .worktrees/<lane>
  ```

  Never track it. `../../node_modules` is right from a worktree and wrong
  from the repo root, so committing it replaces the one real install with a
  link into the parent directory (#51 removed exactly that).

## Git & PRs

- Do not add AI attribution trailers (`Co-authored-by`, sign-offs) to
  commits.

## Working in a repo with preview on

The **preview** branch (default `preview/{base}`) is derived: the base with
each applied lane merged on top, rebuilt with `reset --hard`. It is not a
place work can live — commit on a real branch instead. A `pre-commit` hook
refuses commits made there.

There is exactly one preview, and it is the **workspace root checkout**
switched onto that branch. So in this repo, with preview on, the root is not
somewhere to write at all — every feature belongs in a worktree under
`.worktrees/`.

A worktree you create off the preview base becomes a **candidate**
automatically: it shows as an unchecked row, and nothing of yours is
merged into anyone's preview. Joining is deliberate, and it is yours to
decide — you know whether your work is ready to be seen next to the
other lanes, and a base match does not.

To opt in, once the work is worth previewing:

```sh
# works with VS Code closed; installed while preview is on
"$(git rev-parse --git-common-dir)/gw-lane" add          # current branch
"$(git rev-parse --git-common-dir)/gw-lane" status       # how it built, then what is in it
"$(git rev-parse --git-common-dir)/gw-lane" remove       # take it back out
"$(git rev-parse --git-common-dir)/gw-lane" check        # 0 ok · 1 failed · 2 unknown
"$(git rev-parse --git-common-dir)/gw-lane" rebuild      # rebuild, and wait for it
"$(git rev-parse --git-common-dir)/gw-lane" owner        # who is serving this repo
"$(git rev-parse --git-common-dir)/gw-lane" refresh      # tell the sidebar to look again
```

`rebuild` is real now: a daemon does every preview mutation, and both the
editor and this CLI ask it through a request directory in the git common
dir. So you can fix your lane and then rebuild to *verify* it, rather than
reporting that a rebuild is needed. It starts one if none is running and
exits when idle; `owner` says who is serving.

`refresh` is for the changes the editor cannot see: anything you do with
refs reaches the sidebar on its own (it watches the git dir), but a file
written into a checkout touches nothing under `.git`, and on a filesystem
that drops watch events even commits wait for a 30s poll. It is a signal,
not a request — nothing answers for the UI.

`status` leads with the **last rebuild** (also readable raw as
`focus-status`), because being applied is not the same as being in the tree:
a failed rebuild leaves the checkout on the last good chain, so the lane that
broke it is missing from the preview while `focus-applied` still lists it.
Read the record before concluding anything about the preview — `next:` names
the move that clears it, and `tip:` is what makes a stale conflict
recognisable as one already dealt with. When the failure names **your** lane,
fixing it is ordinary work: catch the lane up in its own worktree, or
`gw-lane remove` so nobody else's preview stays blocked. Then
`gw-lane rebuild` and check the result — verifying is the normal case now,
so reporting "a rebuild is needed" is only honest when the rebuild itself
could not run. The skill's §8 has the guardrails.

Inside the editor the same thing is **Git Workflow: Add to Preview**
(`worktreeCompare.addToPreview`).

The full rules are the skill in
[`skills/git-workflow`](skills/git-workflow/SKILL.md) — **load it before your
first edit**, not at commit time, since by then the work is already in whatever
checkout you were standing in. It is the same document the commit guard points
other repos at, and it self-checks which of its rules apply. This repo is
usually at its top tier: worktrees under `.worktrees/`, preview sometimes
on, the guard installed.

When the workflow changes, the skill changes with it — it is what agents in
other repos will be reading, and a stale copy is worse than none.

Leave it out when the branch is mid-refactor, deliberately broken, or
exploring something that would clash with other lanes. Being out costs
nothing — the row stays visible and one click away.
