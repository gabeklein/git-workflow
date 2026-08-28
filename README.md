# Git Workflow

VS Code / Cursor extension that auto-discovers git worktrees (e.g. under `.worktrees`) and surfaces a GitLens-style **Working Tree ↔ base ref** comparison with **editable** working-tree diffs.

**Repo:** https://github.com/gabeklein/git-workflow  
**Extension id:** `local.git-workflow`  
**License:** MIT

## Install (humans & coding agents)

Run this **on the machine that hosts the worktrees** (for Remote-SSH, that is the **remote**, not the local laptop UI).

### One-shot install from GitHub

```bash
# Prerequisites: Node.js 20+, npm, git
# Optional but recommended: `code` or `cursor` CLI on PATH
# Optional for PR features: GitHub CLI `gh` authenticated

git clone https://github.com/gabeklein/git-workflow.git
cd git-workflow
npm install
npm run install:local
```

Then in VS Code / Cursor: **Developer: Reload Window** (or reconnect the SSH remote).

You should see **Git Workflow** in the activity bar. Open a repo that has linked worktrees — they are discovered via `git worktree list`, wherever they live on disk.

### Agent checklist

Copy-paste for an agent with shell access on the target host:

1. `git clone https://github.com/gabeklein/git-workflow.git && cd git-workflow`
2. `npm install`
3. `npm run install:local`  
   - Builds production `dist/`
   - Packages `artifacts/git-workflow-<version>.vsix`
   - Runs `code` / `cursor` `--install-extension … --force` when a CLI is found
   - Mirrors into `~/.vscode/extensions` **and** `~/.vscode-server/extensions` (Remote-SSH)
4. Tell the user to **Reload Window**, or run a host reload if you control the editor
5. Verify: Extensions view lists **Git Workflow** (`local.git-workflow`); sidebar icon appears

**Do not** rely on F5 / Extension Development Host for end-user install. That only loads the extension in a temporary debug window.

### Update to latest

```bash
cd git-workflow   # existing clone
git pull
npm install
npm run install:local
# Reload Window
```

### Scripts

| Script | What it does |
|--------|----------------|
| `npm run package` | Production `dist/` only |
| `npm run vsix` | Production build + `artifacts/*.vsix` |
| `npm run install:local` | Build → VSIX → editor install → vscode-server mirror |
| `npm run install:skill` | Installs the agent skill into `~/.claude/skills` (`-- --project [dir]` for one repo) |
| `npm run test` | Type-check tests, then unit + EDH suites |
| `npm run test:unit` | Vitest unit tests (`test/unit/*.test.ts`): pure-git logic against scratch repos |
| `npm run test:edh` | Live EDH suite (`test/edh/*.test.ts`, mocha): sample repo + real VS Code, drives preview commands |

### Install notes

The local install **always unpacks the VSIX it just built**. Neither of the alternatives is trustworthy: `code --install-extension` exits 0 even when it prints `Failed Installing Extensions`, and over Remote-SSH it installs to the *server*, leaving `~/.vscode/extensions` untouched — so an existing folder there proves nothing about its age. It was previously the mirror source, which is how a build from weeks earlier could keep being installed while the script reported success. A size check on the installed bundle warns if anything still serves a stale copy.

- VSIX path: `artifacts/git-workflow-<version>.vsix` (gitignored). Runtime bundle is `dist/` (packaged inside the VSIX).
- **Remote-SSH:** run install on the remote. The extension host does not use the client’s `~/.vscode/extensions` alone.
- **Cursor:** if `code` is missing, ensure `cursor` is on PATH, or set `VSCODE_CLI=/path/to/cursor`.
- Env overrides: `SKIP_CODE_CLI=1`, `SKIP_SERVER=1`.
- **PR features** need authenticated `gh` (`gh auth login`). Without it, worktree compare and the Branches panel still work; PR tags/badges stay empty.
- **Dev vs installed:** F5 EDH overrides the installed copy **only in the debug window**. Daily use = installed VSIX.

### Manual alternative

```bash
npm run vsix
code --install-extension ./artifacts/git-workflow-0.0.1.vsix --force
# Reload window
```

## Agent skill

The rules this extension enforces are not discoverable from the code an agent is
looking at — a derived branch it must not commit to, lane files it must not
hand-edit, a headless opt-in it would never guess. They live in
[`skills/git-workflow/SKILL.md`](skills/git-workflow/SKILL.md), written to be
read by an agent and self-checking: it opens by establishing how much of itself
applies, and says plainly to stop reading in a repo that has no worktrees.

**The intended way it spreads is the commit guard.** When the hook refuses a
commit on the preview branch, the refusal names the skill's URL — that is
the one moment an agent that does not know this workflow is guaranteed to be
listening, and it is what stops the message's own `--no-verify` line from being
the easiest thing to act on. No install command is issued and no tool's config
path appears in a git hook: the agent fetches a document and decides where its
own skills live.

Caveat worth knowing: the hook only exists while preview is on. With
preview off there is no refusal, so nothing nudges — a repo that wants the
rules regardless should reference the file from its own agent instructions. This
one does: [`CLAUDE.md`](CLAUDE.md) is a single `@AGENTS.md`, and
[`AGENTS.md`](AGENTS.md) imports the skill, so it loads before the first edit
rather than after the first mistake.

`npm run install:skill` copies it to `~/.claude/skills/git-workflow` (or
`-- --project [dir]` for one repo). That is a convenience for people who have
already cloned this repo to work on it — nobody clones an extension to install a
skill, and it is deliberately not part of `install:local`, since writing into
`~/.claude` is a different decision from installing an extension.

## Develop (fast iteration)

```bash
npm install
npm run watch   # or press F5 (one-shot compile via preLaunchTask)
```

1. Open this folder in VS Code / Cursor (on the machine that has the worktrees — e.g. Remote-SSH).
2. **F5** → Extension Development Host (or **Run Extension (clean host)** to disable other extensions).
3. Open a repo that has worktrees under a watched folder.
4. After source changes: save / recompile → **Developer: Reload Window** in the EDH.

The EDH window loads the project via `--extensionDevelopmentPath` and **overrides** any installed copy **only in that window**.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `worktreeCompare.watchFolders` | `[".worktrees"]` | Where new worktrees are created (auto-added to `.git/info/exclude`); discovery uses `git worktree list` |
| `worktreeCompare.includeRootCheckout` | `dirty` | `dirty` / `always` / `never` — root checkout in the list (hide when clean by default) |
| `worktreeCompare.defaultBaseRef` | `main` | Fallback when fork point cannot be inferred |
| `worktreeCompare.squashLayout` | `list` | Full Diff files: `list` or `tree` |
| `worktreeCompare.contentRefreshIntervalMs` | `0` | Idle poll (`0` = off, events only) |
| `worktreeCompare.contentRefreshActiveIntervalMs` | `2500` | Faster poll after a change (only if poll enabled) |
| `worktreeCompare.contentRefreshIdleAfterMs` | `20000` | Quiet time before poll relaxes (only if poll enabled) |
| `worktreeCompare.githubPullRequests` | `auto` | `auto` / `off` — PR tags on worktrees & branches, needs `gh` |
| `worktreeCompare.remotePrLimit` | `30` | Max open PRs fetched for Branches-panel tags |
| `worktreeCompare.previewBranch` | `preview/{base}` | Branch the root checkout switches to for preview mode ({base} = short base name; `focus/working` for script interop) |
| `worktreeCompare.previewAutoRebuild` | `true` | Rebuild the preview tree when base / lane tips move |
| `worktreeCompare.previewFetchIntervalMs` | `300000` | Fetch `origin/<base>` this often while preview is on (`0` = off); landed lanes retire automatically |
| `worktreeCompare.catchUpStrategy` | `auto` | How **Catch Up with Base** works: `auto` (rebase unpushed lanes, merge pushed ones), `rebase`, or `merge` |
| `worktreeCompare.previewAbsorbStrays` | `true` | Move work committed on the preview branch onto the base by itself (off = the rebuild refuses until you run **Absorb** by hand) |
| `worktreeCompare.previewCommitGuard` | `true` | Install a `pre-commit` hook refusing commits made on the preview branch; `git commit --no-verify` overrides. An existing `pre-commit` hook is chained into, not replaced |
| `worktreeCompare.autoRemoveLandedWorktrees` | `true` | Remove a landed branch's checkout once it holds nothing of its own (ref kept); off keeps the folder and badges the row `landed · on disk` |
| `worktreeCompare.pruneRemoteRefs` | `true` | Prune remote-tracking refs origin no longer has, on the full refresh (throttled) — without it (and without `fetch.prune`) a branch deleted by a merged PR shows under **Remote** forever |
| `worktreeCompare.autoRebaseLanes` | `off` | `local-only` auto-catches-up clean, behind, conflict-free, **unpushed** linked worktrees as the base moves |

## Preview (overlay)

Preview is the **leading row of the Lanes panel**, always visible: it shows its base, lane count, `+wip`, and any failure state, with the lanes as its children. When off, the row reads **Create Preview** and turning it on is one click. There is no group heading above it — there is exactly one preview, so a list that can never hold a second entry would be a nesting level for nothing.

The preview is the **workspace root checkout**, switched to the preview branch (default `preview/{base}`, e.g. `preview/main`); disabling switches it back to the branch it was on. That is the only shape it takes. The root is otherwise the most dangerous checkout in the repo — it sits on the base, so a feature written there moves the base branch rather than landing on a lane — and making it the preview turns that hazard into a single rule, *never write here*, which the commit guard enforces and Absorb rescues you from. The same branch checked out in a linked worktree is left strictly alone: not rebuilt, not guarded, not shown.

Disabling also **deletes the preview branch** — it is derived state, and the lane lists survive in `focus-applied`/`focus-candidates`, so re-enabling restores the same setup. Changing the base renames the branch to match (`preview/main` → `preview/staging`).

The preview checkout is rebuilt as **base + a merge of each applied lane**, so you can run/test any combination of feature branches together while each branch stays clean. Only **landed commits** are merged — a dirty feature worktree never leaks into the preview tree.

- Membership is **automatic by base**: every worktree whose own base — manual override or *genuine* inference (branch config / reflog / upstream), never a guessed fallback — matches the preview base appears as a row under **Preview**, each with a **checkbox**: checked = its branch is merged in. Stacked lanes (based on a parent branch) and worktrees whose base can't be inferred stay out. **Candidacy is automatic; inclusion never is** — a base match says two lanes *can* merge, not that they belong in the same preview, so joining is always somebody's decision. An unchecked candidate row is the visible evidence that a lane exists and is out, which is what keeps opt-in from failing silently. An empty lane cut from a stale base is re-pointed to the current base so its first commit starts from the right place — moving a lane is not enrolling it. **Add to Preview** remains for branches on a different or unknown base, and **Remove from Preview** works on every row — removing an auto member records a persistent exclusion (`focus-excluded`) so it stays gone until added back.
- The row description shows the **base** (`→ main`) every rebuild starts from — current base tip + lanes is exactly what landing those PRs would produce. Its context menu has **Rebuild**, **Change Preview Base…** (sets workspace-scoped `previewBaseRef`; empty = `defaultBaseRef`), and **Disable Preview Mode…**.
- The merge chain is computed **off-tree** (`git merge-tree --write-tree` + `commit-tree`, git ≥ 2.38; older git falls back to in-tree merges) and applied with a single `reset --hard`. A conflicting lane fails the rebuild **without touching the checkout** — the lane shows `conflict`, and unchecking it (or landing a fix on it) recovers. Files that didn't change aren't rewritten, so a running dev server sees one small burst, not lane-by-lane churn.
- **Frozen base & drift**: enabling preview **pins** the base (`<git-common-dir>/focus-base`). The effective base follows `origin/<base>` whenever that is a descendant of the pin — published movement is always legit — and otherwise holds the pin, so commits made directly on the local base branch (by accident, or before thinking about preview) never silently retarget the preview or churn every lane's badges. When the local base moves past the frozen base, its unpushed commits appear under Preview as a **lane**: `main · +N unpushed`, with a checkbox — **checked by default**, so deliberate work in a main checkout shows up in the preview immediately, visibly, without ever becoming the floor. Unchecking excludes it and **persists** across future commits. The row's context menu offers **Move New Base Commits to a Branch…** (they become a real feature branch and the base branch returns to the frozen point — never over uncommitted changes) and **Catch Up Preview Base** (advance the pin deliberately); pushing the base lands the segment and the row disappears. `origin/<base>` is fetched periodically while preview is on (`previewFetchIntervalMs`, non-blocking; manual Rebuild fetches first). A lane is **landed** by the same probe the branch prune uses (ancestry, a content check, and — for a landing the base has since moved past — reproducing the squash), which makes the check *revert-safe*: a merged-then-reverted lane is not landed and re-applies as a real merge. Sharing that probe matters: retirement used to run a weaker check of its own, so a lane that landed and then watched other PRs merge on top would conflict against the base, never read as landed, never retire, and sit in the preview reporting a conflict indefinitely. Landed lanes retire automatically (unapplied under the rebuild lock, row stays with a green `landed` tag).
- **Lane order is one ordered list, and lanes can be dragged to change it.** `focus-candidates` holds the ORDER (every lane, checked or not) and `focus-applied` holds membership as a set; merge order is the candidate list filtered to applied. This matters because the resolver is order-sensitive — union inserts land in merge order, and best-effort resolves same-line clashes toward the *incoming* lane — so the order has to be something you state rather than something a sort or a checkbox decides. Keeping the two apart is also what stops a toggle from moving a row: checking a lane changes a checkbox, and an unchecked lane holds its place until it is checked again.
- **Lane rows render in merge order.** Applied lanes are listed in the order they will be merged; unapplied candidates follow as a sorted set, having no position in the chain. Sorting the applied ones showed an order the rebuild does not use, on exactly the question where order decides the outcome.
- **Reordering**: drag a lane onto another to merge it *before* that one, or onto empty space to send it last. The move takes the rebuild lock (the file is shared with the shell script and rewritten by rebuilds retiring landed lanes), and a drop that arrives while a rebuild owns it is dropped rather than queued: the tick that follows renders the order that actually exists.
- **The committed chain is memoized** per checkout, keyed on the base, the resolver mode, and every lane's tip **in order**. A wip overlay rebuilds on each save, and splitting wip into a final overlay left the committed part identical between those rebuilds — so a save costs one merge on top of a cached tip rather than the whole chain again. In memory only (a reload recomputes once), and the cached tip is verified to still exist before use, since disabling preview deletes the branch that made it reachable.
- **Working-tree overlay** (per lane, opt-in): **Include Working-Tree Edits** on a lane row also overlays the checkout's *uncommitted* changes (staged + unstaged + untracked) into rebuilds — via an ephemeral snapshot commit built with a temporary index, so the lane's branch, HEAD, and index are never touched. The overlay is applied **last, on top of the finished chain** (merge base = the lane's own tip, so what lands is exactly the uncommitted delta) rather than by moving the dirty lane to the end — reordering would relocate its *committed* work too, letting whichever worktree happens to be dirty change how every other lane resolves. A wip conflict goes through `previewAutoResolve` like any other, so a lossy win is tagged rather than silent, and a lane holding wip is never retired as landed. Saves in VS Code re-trigger the rebuild (editor events only, by design); the lane and panel show `+wip`. Note wip lanes weaken the PR-simulation guarantee — you're previewing unlanded state.
- **Auto-resolution** (`previewAutoResolve`, default `best-effort`): edits to different lines of the same file always merge — that's git's default. On top of that a per-file resolver handles the *petty* conflicts that used to fail rebuilds: when both lanes only **inserted** lines (changelog appends, import lists, same-point inserts) they merge as a **union** — both survive; **adjacent-line edits** merge by linewise 3-way — the changed side wins per line. Both are lossless and silent. Under `best-effort`, remaining text clashes (same-line divergence, add/add) resolve toward the incoming lane and the row is **tagged `auto-resolved`** with the dropped-hunk files listed — the preview always builds, honesty preserved. `whitespace` stops after the lossless rules; `off` is strict. Structural conflicts (edit vs delete) always fail honestly. Preview is a best-effort preview of unlanded work — Catch Up with Base on the lane makes it exact.
- With `previewAutoRebuild` on, committing (or amending / rebasing) on an applied lane rebuilds automatically — no git hooks needed. Change detection is event-driven: Node `fs.watch` on each repo's `.git` (`refs/`, `logs/`, `worktrees/`, `packed-refs` — never `objects/`, and not the VS Code host watcher), with a slow 30s poll as fallback for filesystems that drop events; if watch setup fails entirely, the poll runs at 4s.
- Guard rails: a rebuild refuses when the preview checkout itself is dirty or carries commits that belong to no lane.
- **Committing on the preview branch is refused** (`previewCommitGuard`). The branch is derived and every rebuild recreates it with `reset --hard`, so a commit made there has no home — and **Absorb**, the rescue, can only ever aim at the *base*, which is the wrong destination when the work belonged to a lane. Nothing after the fact can tell the difference, so the hook stops the commit while the author still knows which branch they meant; the working tree is left exactly as it was, and the message names the exits (check out the real branch, **Absorb Preview Edits**, or `git commit --no-verify`). The hook goes wherever git actually looks (`core.hooksPath` when set — husky and friends — otherwise the git *common* dir), so it covers every worktree of the repo from one file and exits immediately on any branch but the guarded one; the guarded name lives in `<git-common-dir>/focus-guard`, so a renamed preview branch can never leave it guarding a name that no longer exists. **An existing `pre-commit` hook is chained into, never replaced** — a repo can only have one, so the refusal lives in its own script and two marked lines are spliced in below the shebang, above their body. Uninstalling takes those two lines back out and leaves the rest verbatim. A hook that is *not* a shell script (Python, Node) is left strictly alone, since splicing `sh` into it would break every commit in the repo.
- Absorb **waits out a busy target**: it writes through the base checkout's index, which the extension, VS Code's git extension and any terminal are all touching, so a held `index.lock` is retried with a short backoff and — only if it never clears — reported as `busy` rather than as a conflict. An automatic absorb deferred this way retries on the next tick instead of counting as its one attempt at that commit.
- Absorbed commits carry their provenance: git's own `(cherry picked from commit <sha>)` line plus an `Absorbed-from: <branch>` trailer. The source commit lives on a branch the next rebuild destroys, so the sha stops resolving almost immediately — the trailer is the half that still answers "where did this come from" later.
- **Headless opt-in**: while preview is on, `<git-common-dir>/gw-lane` is installed — `gw-lane status|add|remove [branch]`. Inclusion is deliberate, and the party doing the work is increasingly an agent that cannot reach a VS Code command, so without a headless surface opt-in just means an empty preview. It speaks the file protocol directly (taking the same `focus-working.lock`, waiting for it rather than failing), so it works with the editor closed. It lives inside `.git`, so it is never committed, is refreshed on every enable, and — unlike a path inside the extension's install directory — does not break when the extension updates.
- Applied lanes live in `<git-common-dir>/focus-applied` (candidates in `focus-candidates`) and rebuilds take `<git-common-dir>/focus-working.lock` — the same protocol as agent-focus's `scripts/focus-working.sh`, so the script, its `post-commit` hook, and this extension can be mixed freely.

**Sync with Remote** (context menu on any worktree or branch row) reconciles a branch with **its own upstream** — not with the base. It fast-forwards when only origin moved, pushes when only you did, and publishes a branch origin has never seen (`push -u`). When **both** sides have moved it stops and says so, offering Catch Up instead of choosing.

That refusal is the point. `catchUpStrategy` is tuned for lane-vs-base, where being ahead is normal and lanes are usually unpushed, so rebase is safe. A diverged *upstream* is a different situation: the branch is published by definition, so `auto` would collapse to always-merge (a merge commit on the feature branch, in the PR diff) and `rebase` would force-push over commits someone else — or an agent — already put on origin. Nothing else here rewrites published history without being asked, and a context menu is not the place to guess. Fast-forwarding a checked-out branch merges inside its worktree (`--ff-only`, so git refuses rather than clobbering uncommitted work); a branch with no checkout is moved by the fetch instead, which is the only way to reach it.

## Pruning landed branches

**Prune Landed Branches** (on the Lanes panel's **Landed** group row) deletes local branches whose work is already in the base. It exists because `git branch -d` cannot do this job: it decides "merged" by **ancestry**, and a squash-merged branch is not an ancestor of anything — so it refuses, and the only way past it is `-D`, which deletes unmerged work just as happily. At any real merge rate the local branch list grows without bound and nobody dares run the blunt version.

Landing is decided by a stack of probes, each of which can only ever say *landed* (a miss means keep the branch — a false negative wastes disk, a false positive deletes work):

1. **ancestry** — a true merge;
2. **content** — merging it into the base right now changes nothing, which covers a branch that landed while the base sat still;
3. **the squash it landed as** — a squash commit is built by merging the branch into the base as it stood just before, so if applying the branch to some commit's *parent* reproduces that commit's tree exactly, that commit **is** this branch.

Probe 3 is what makes this work on stale crust. A "would merging it change anything" test alone reports *not landed* as soon as later work touches the same files, so old branches accumulate forever — measured on this repo, it missed 6 of 10 genuinely-landed branches.

Having found where a branch landed, probe 3 re-applies that commit's own delta to the current base and reads three outcomes apart: a **no-op** means the landing is intact; a **conflict** means later work evolved those same lines, which is still landed (the base built *on* it); a **clean change** means the work is cleanly absent, so re-applying restores it — that is a **revert**, and the branch is the way back, so it is never offered. History-based tests (`git cherry`, patch-id comparison) are deliberately not used: a reverted squash still satisfies both, and the branch that could restore it is exactly what would be deleted.

A multi-select picker shows what landed and how (`merged` / `squashed or rebased in`) and flags branches `origin` still has. A branch still **checked out** is included: `git branch -D` cannot touch a checked-out ref, so prune removes the holding worktree first — under the same conditions as the landed quick-delete (clean, unlocked, no ignored files), since ignored files are the one thing removal can still destroy. A checkout that fails those keeps its folder and says which condition stopped it. Every branch is **re-verified against the base immediately before deletion**, so a lane an agent committed to while the picker was open is kept, not deleted. The base and the preview branch are never offered. Agents and tests can pass names directly (`{ branches: [...] }`) to skip the picker; the proof still runs.

## Catching lanes up with the base

Base conflicts dominate multi-branch workflows (peer-lane conflicts are rare), so staleness is surfaced on the **worktree rows**: `N behind <base>`, `conflicts with <base>`, `rebasing`, or `merging base`. Every badge is computed against the same per-worktree base the Commits/Full Diff views use, and the paused states are probed from real git state (`rebase-merge`/`MERGE_HEAD`) — operations started in a terminal show the same controls.

With `autoRebaseLanes: local-only` (**off** by default — moving your branch is a side effect you opt into), linked worktrees that are **clean, unpushed, behind, and conflict-free** are caught up automatically as the base moves, using `catchUpStrategy`'s method. Pushed branches are never rewritten automatically. Attempts are memoized per (tip, base) so failures don't loop, and a conflicting attempt aborts immediately — auto operations never leave a paused rebase/merge behind — marking the row `conflicts with <base>` for the manual flow.

Manual flow, from the row's context menu:

- **Catch Up with Base…** picks the method via `catchUpStrategy` — `auto` (default) rebases unpushed lanes and merges the base into pushed ones (no force-push, PR review anchors survive; squash landings erase the merge bubbles anyway). **Rebase onto Base…** and **Merge from Base…** force one method explicitly.
- A conflicted **rebase** pauses: the marked files open for VS Code's inline conflict UI, the row flips to `rebasing`, and **Continue Rebase** (refuses while conflict markers remain; loops to the next conflicting commit) or **Abort Rebase** finish it. After rebasing a pushed branch you're offered **Force Push (with lease)** — never automatic.
- A conflicted **merge** pauses the same way (`merging base`, **Complete Merge from Base** / **Abort Merge from Base**); completing a pushed lane's merge offers a plain **Push**.
- Every operation refuses to start on a dirty worktree, or when a rebase/merge is already in progress there — the extension never aborts an operation it didn't start.

Applied preview lanes that conflict with the base are re-probed on every refresh, so the `conflict` badge and **Resolve Conflict with Base…** (which runs the base merge in the lane's own worktree — the same conflict its PR would hit) survive window reloads.

**Catch Up after a squash merge.** When a lane was stacked on a branch that has since been squash-merged, the base carries that work as one new commit while the lane still carries the originals — so `base..HEAD` lists commits whose content is already landed, and replaying them conflicts against work nobody is actually disputing. Catch Up detects this by **content** (the parent branch is usually deleted by then) and rebases with `--onto`, replaying only what has not landed. The probe applies each commit's own delta to the base and asks whether anything would change — the same cherry-pick-semantics merge the absorb path uses — scanning newest-first so it finds the furthest point already in the base. A **merge** cannot skip history that way, so when this is detected the merge is refused with an explanation rather than handing over an unresolvable conflict; rebasing rewrites history, so that stays the user's call.

## Base ref inference

When you expand a worktree, the compare base is resolved in order:

1. Manual override (Change Base Ref)
2. `branch.<name>.vscode-merge-base` (and similar config keys)
3. Reflog `Created from <ref>` / `checkout: moving from <ref>` (e.g. `origin/staging`)
4. `@{upstream}` only when it is **not** the same feature branch on a remote
5. Closest ancestor among `main` / `staging` / `develop` / … (prefers `origin/*`)
6. Configured default

Picking a bare local name like `staging` upgrades to `origin/staging` when that remote-tracking ref exists (local preview branches are often stale).

While preview mode is active, step 6's configured default is the **preview base** — lanes land there, so when inference has nothing better, Commits/Full Diff compare against the same base the preview tree is built from.

Check **Output → Git Workflow** for lines like `Inferred base for …`.

## Sidebar layout

**Lanes** comes first, because it is the **selector**: you click a row there to choose what Focus shows. Selector above detail is the order every other pair in the sidebar uses — Explorer above Outline, repositories above changes — and it is the order you read in, since picking the lane is the step before working in it. It also keeps the preview row, the panel's most consequential state, from sitting below a Focus panel that grows with the diff. (View order is only a default; VS Code remembers your own arrangement, so an existing window keeps whatever you dragged it into.)

**Lanes** panel (selector — header shows the checkout count):

```
▼ Preview        the derived preview, expanding to its lanes
▼ Working        has a checkout, root first then tip recency  ← click to focus
▼ Local          has a local ref, no checkout — ↑ahead ↓behind vs origin
▶ Remote         no local ref (hidden when there are none)
▶ Landed         in the base, ref only (hidden when empty) — Prune lives here
```

**Preview** leads: it is what the lanes below are combined *into*. It holds one row per preview — base drift first, then the applied and candidate lanes with their checkboxes — and everything the Preview panel's title menu used to carry (Rebuild, Change Base…, Absorb, Disable) is now that row's context menu. The group stays visible when preview is off, offering to enable it; a group that vanishes is a feature nobody finds. A **landed** lane drops out of Preview rather than lingering with a tag, since Landed is a group in the same panel and one branch belongs in one place.

The groups are a **ladder**, not four categories: each rung is what falls through the one above it, so a branch appears in exactly one. A branch that exists both locally and on the remote stays in **Local** — its sync state is a badge (`↑2 ↓1`), not a second row. Those counts come from `%(upstream:track)` in the ref listing the panel already runs, so every branch's divergence costs no extra git call. A branch with no upstream shows nothing: it is not *ahead* of anything, it is unpublished, and the row says that by other means. An upstream that was deleted (`[gone]`) shows nothing either, since a count against a missing ref would be meaningless.

**Working wins over Landed**, so a folder on disk is always reported as one. A landed branch that still had a checkout used to render under Landed, where it looked exactly like a branch that was only a ref — the folder was invisible, which is how stale checkouts piled up. Now:

- a landed checkout that holds **nothing of its own** is removed on sight — clean, unlocked, attached, no ignored files, no paused rebase/merge, nothing open in an editor (`autoRemoveLandedWorktrees`). The branch **ref is never deleted**; that is Prune Landed Branches' job, which proves the landing three ways and asks. This only ever gives back a folder `git worktree add` recreates;
- anything else stays under **Working**, badged with the reason: `landed · uncommitted changes`, `landed · ignored files`, `landed · open in an editor`, `landed · rebase/merge paused`, `landed · locked`. Each is a thing only a human can resolve, and the tooltip says what resolving it does. With automatic removal off the row reads `landed · on disk` — the visibility is the bug being fixed, not what the switch turns off.

So **Landed** is refs waiting to be pruned, and a `landed · …` row under Working is exactly the set that needs you. Ignored files are singled out because they are the one thing removal could actually destroy: `git worktree remove` takes a local `.env` or build output without complaint, and the dirty probe cannot see them.

Rows are tagged with `worktree` / `PR #N` / `conflicts` / `T ago`, and carry a `●` badge when the branch is in the preview preview. Create a worktree from any branch row (inline action); PR rows expand into read-only file diffs.

**Focus** panel (presentation — header shows the focused branch):

```
⚠ PR #N has merge conflicts          ← GitHub conflicts only
▶ Directory              .worktrees/feat-a   ← the focused worktree's working tree
▼ Staged / Unstaged                  ← hidden if empty; commit via context menu
▼ Commits · N                        description: → base [@sha]
▶ Full Diff · N new · M modified · …  ← collapsed until opened
```

The row's description says **where that checkout is**, in the shortest form that is true: `.` for the workspace root, `x` inside it, `../x` beside it (the usual worktree layout), `~/x` under home, absolute otherwise. Shortest rather than a fixed order, because a preference gets it wrong both ways — `../../Users/you/Projects/thing` is not "beside" anything and is plainly worse than `~/Projects/thing`, while a real sibling reads better as `../other` than as either. **Copy Path** is on the section row (the checkout root) and on any file or folder in it.

The **Directory** section browses and opens the worktree's files as **real editable buffers**, not diffs. It is *Directory* and not *Files* because under a panel called Changes, "Files" reads as the changed files — the one thing it is not. The listing is git-driven (tracked + untracked, `.gitignore` respected — no `node_modules` noise) and follows focus; `New File…` / `Delete` sit on the section row and the context menus, and it refreshes on git activity and file events. It exists because the built-in Explorer can only reveal paths inside a workspace folder — a sibling worktree is outside every one of them — and converting the window to multi-root restarts the extension host.

Selection is persisted per workspace. Compare defaults to merge-base of the preview tip (not “must rebase” when main moves).

## Roadmap

- [x] Extension scaffold (TreeView shell, config, F5/watch)
- [x] Discover worktrees under watch folders
- [x] Compare Working Tree vs base (ahead/files; fork-point default)
- [x] Open diffs with real worktree file paths (editable)
- [x] QuickPick to change compare base ref
- [x] Infer fork point (reflog / vscode-merge-base / defaults)
- [x] Hot-follow (events; optional decaying poll)
- [x] SCM-like Staged / Changes + Full Diff
- [x] GitHub PR status, delete/unlock worktree, Remote PRs + checkout
- [x] Local/daily install via `npm run install:local`
- [ ] Stage Selected Ranges / richer SCM parity
- [ ] Two-view split if single tree gets dense
