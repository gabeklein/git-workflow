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
| `npm run test` | Type-check tests, then unit + EDH suites |
| `npm run test:unit` | Vitest unit tests (`test/unit/*.test.ts`): pure-git logic against scratch repos |
| `npm run test:edh` | Live EDH suite (`test/edh/*.test.ts`, mocha): sample repo + real VS Code, drives integration commands |

### Install notes

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
| `worktreeCompare.integrationBranch` | `integration/{base}` | Branch that opts a checkout into the overlay ({base} = short base name; `focus/working` for script interop) |
| `worktreeCompare.integrationAutoRebuild` | `true` | Rebuild the integration tree when base / lane tips move |
| `worktreeCompare.integrationFetchIntervalMs` | `300000` | Fetch `origin/<base>` this often while integration is on (`0` = off); landed lanes retire automatically |
| `worktreeCompare.catchUpStrategy` | `auto` | How **Catch Up with Base** works: `auto` (rebase unpushed lanes, merge pushed ones), `rebase`, or `merge` |
| `worktreeCompare.autoRebaseLanes` | `off` | `local-only` auto-catches-up clean, behind, conflict-free, **unpushed** linked worktrees as the base moves |

## Integration worktree (overlay)

Integration lives in its own **Integration** panel below the Worktree view. Its description shows mode status (`off`, `→ main`, or an error state); when off, the panel offers an **Enable Integration Mode** button. Enabling asks you to pick:

- **Use this checkout** (default) — the workspace root switches to the integration branch (default `integration/{base}`, e.g. `integration/main`) and becomes the integration surface; disabling switches it back to the branch it was on.
- **Create a separate worktree…** — a dedicated checkout holds the combined lanes.

Disabling also **deletes the integration branch** — it is derived state, and the lane lists survive in `focus-applied`/`focus-candidates`, so re-enabling restores the same setup. Changing the base renames the branch to match (`integration/main` → `integration/staging`).

The integration checkout is rebuilt as **base + a merge of each applied lane**, so you can run/test any combination of feature branches together while each branch stays clean. Only **landed commits** are merged — a dirty feature worktree never leaks into the integration tree.

- Membership is **automatic by base**: every worktree whose own base — manual override or *genuine* inference (branch config / reflog / upstream), never a guessed fallback — matches the integration base appears as a row in the Integration panel, each with a **checkbox**: checked = its branch is merged in. Stacked lanes (based on a parent branch) and worktrees whose base can't be inferred stay out. **Candidacy is automatic; inclusion never is** — a base match says two lanes *can* merge, not that they belong in the same preview, so joining is always somebody's decision. An unchecked candidate row is the visible evidence that a lane exists and is out, which is what keeps opt-in from failing silently. An empty lane cut from a stale base is re-pointed to the current base so its first commit starts from the right place — moving a lane is not enrolling it. **Add to Integration** remains for branches on a different or unknown base, and **Remove from Integration** works on every row — removing an auto member records a persistent exclusion (`focus-excluded`) so it stays gone until added back.
- The panel description shows the **base** (`→ main`) every rebuild starts from — current base tip + lanes is exactly what landing those PRs would produce. The panel's title menu has **Rebuild**, **Change Integration Base…** (sets workspace-scoped `integrationBaseRef`; empty = `defaultBaseRef`), and **Disable Integration Mode…**.
- The merge chain is computed **off-tree** (`git merge-tree --write-tree` + `commit-tree`, git ≥ 2.38; older git falls back to in-tree merges) and applied with a single `reset --hard`. A conflicting lane fails the rebuild **without touching the checkout** — the lane shows `conflict`, and unchecking it (or landing a fix on it) recovers. Files that didn't change aren't rewritten, so a running dev server sees one small burst, not lane-by-lane churn.
- **Frozen base & drift**: enabling integration **pins** the base (`<git-common-dir>/focus-base`). The effective base follows `origin/<base>` whenever that is a descendant of the pin — published movement is always legit — and otherwise holds the pin, so commits made directly on the local base branch (by accident, or before thinking about integration) never silently retarget the preview or churn every lane's badges. When the local base moves past the frozen base, its unpushed commits appear in the panel as a **lane**: `main · +N unpushed`, with a checkbox — **checked by default**, so deliberate work in a main checkout shows up in the preview immediately, visibly, without ever becoming the floor. Unchecking excludes it and **persists** across future commits. The row's context menu offers **Move New Base Commits to a Branch…** (they become a real feature branch and the base branch returns to the frozen point — never over uncommitted changes) and **Catch Up Integration Base** (advance the pin deliberately); pushing the base lands the segment and the row disappears. `origin/<base>` is fetched periodically while integration is on (`integrationFetchIntervalMs`, non-blocking; manual Rebuild fetches first). A lane is **landed** when merging it would change nothing — ancestry for true merges, a strict content probe for squash/rebase landings — which makes the check *revert-safe*: a merged-then-reverted lane is not landed and re-applies as a real merge. Landed lanes retire automatically (unapplied under the rebuild lock, row stays with a green `landed` tag).
- **Working-tree overlay** (per lane, opt-in): **Include Working-Tree Edits** on a lane row also overlays the checkout's *uncommitted* changes (staged + unstaged + untracked) into rebuilds — via an ephemeral snapshot commit built with a temporary index, so the lane's branch, HEAD, and index are never touched. Saves in VS Code re-trigger the rebuild (editor events only, by design); the lane and panel show `+wip`. Note wip lanes weaken the PR-simulation guarantee — you're previewing unlanded state.
- **Auto-resolution** (`integrationAutoResolve`, default `best-effort`): edits to different lines of the same file always merge — that's git's default. On top of that a per-file resolver handles the *petty* conflicts that used to fail rebuilds: when both lanes only **inserted** lines (changelog appends, import lists, same-point inserts) they merge as a **union** — both survive; **adjacent-line edits** merge by linewise 3-way — the changed side wins per line. Both are lossless and silent. Under `best-effort`, remaining text clashes (same-line divergence, add/add) resolve toward the incoming lane and the row is **tagged `auto-resolved`** with the dropped-hunk files listed — the preview always builds, honesty preserved. `whitespace` stops after the lossless rules; `off` is strict. Structural conflicts (edit vs delete) always fail honestly. Integration is a best-effort preview of unlanded work — Catch Up with Base on the lane makes it exact.
- With `integrationAutoRebuild` on, committing (or amending / rebasing) on an applied lane rebuilds automatically — no git hooks needed. Change detection is event-driven: Node `fs.watch` on each repo's `.git` (`refs/`, `logs/`, `worktrees/`, `packed-refs` — never `objects/`, and not the VS Code host watcher), with a slow 30s poll as fallback for filesystems that drop events; if watch setup fails entirely, the poll runs at 4s.
- Guard rails: a rebuild refuses when the integration checkout itself is dirty or carries commits that belong to no lane.
- Applied lanes live in `<git-common-dir>/focus-applied` (candidates in `focus-candidates`) and rebuilds take `<git-common-dir>/focus-working.lock` — the same protocol as agent-focus's `scripts/focus-working.sh`, so the script, its `post-commit` hook, and this extension can be mixed freely.

## Catching lanes up with the base

Base conflicts dominate multi-branch workflows (peer-lane conflicts are rare), so staleness is surfaced on the **worktree rows**: `N behind <base>`, `conflicts with <base>`, `rebasing`, or `merging base`. Every badge is computed against the same per-worktree base the Commits/Full Diff views use, and the paused states are probed from real git state (`rebase-merge`/`MERGE_HEAD`) — operations started in a terminal show the same controls.

With `autoRebaseLanes: local-only` (**off** by default — moving your branch is a side effect you opt into), linked worktrees that are **clean, unpushed, behind, and conflict-free** are caught up automatically as the base moves, using `catchUpStrategy`'s method. Pushed branches are never rewritten automatically. Attempts are memoized per (tip, base) so failures don't loop, and a conflicting attempt aborts immediately — auto operations never leave a paused rebase/merge behind — marking the row `conflicts with <base>` for the manual flow.

Manual flow, from the row's context menu:

- **Catch Up with Base…** picks the method via `catchUpStrategy` — `auto` (default) rebases unpushed lanes and merges the base into pushed ones (no force-push, PR review anchors survive; squash landings erase the merge bubbles anyway). **Rebase onto Base…** and **Merge from Base…** force one method explicitly.
- A conflicted **rebase** pauses: the marked files open for VS Code's inline conflict UI, the row flips to `rebasing`, and **Continue Rebase** (refuses while conflict markers remain; loops to the next conflicting commit) or **Abort Rebase** finish it. After rebasing a pushed branch you're offered **Force Push (with lease)** — never automatic.
- A conflicted **merge** pauses the same way (`merging base`, **Complete Merge from Base** / **Abort Merge from Base**); completing a pushed lane's merge offers a plain **Push**.
- Every operation refuses to start on a dirty worktree, or when a rebase/merge is already in progress there — the extension never aborts an operation it didn't start.

Applied integration lanes that conflict with the base are re-probed on every refresh, so the `conflict` badge and **Resolve Conflict with Base…** (which runs the base merge in the lane's own worktree — the same conflict its PR would hit) survive window reloads.

## Base ref inference

When you expand a worktree, the compare base is resolved in order:

1. Manual override (Change Base Ref)
2. `branch.<name>.vscode-merge-base` (and similar config keys)
3. Reflog `Created from <ref>` / `checkout: moving from <ref>` (e.g. `origin/staging`)
4. `@{upstream}` only when it is **not** the same feature branch on a remote
5. Closest ancestor among `main` / `staging` / `develop` / … (prefers `origin/*`)
6. Configured default

Picking a bare local name like `staging` upgrades to `origin/staging` when that remote-tracking ref exists (local integration branches are often stale).

While integration mode is active, step 6's configured default is the **integration base** — lanes land there, so when inference has nothing better, Commits/Full Diff compare against the same base the integration tree is built from.

Check **Output → Git Workflow** for lines like `Inferred base for …`.

## Sidebar layout

**Worktrees** panel (selector — header shows the count):

```
branch rows (PR / pushed / local / applied)  ← click to focus
```

**Changes** panel (presentation — header shows the focused branch):

```
⚠ PR #N has merge conflicts          ← GitHub conflicts only
▼ Commits · N                        description: → base [@sha]
▼ Staged / Unstaged                  ← hidden if empty; commit via context menu
▶ Full Diff · N new · M modified · …  ← collapsed until opened
```

**Files** panel (explorer for the focused worktree — header shows its branch): browse and open the worktree's files as **real editable buffers**, not diffs. The listing is git-driven (tracked + untracked, `.gitignore` respected — no `node_modules` noise) and follows focus. `New File…` / `Delete` via the title button and context menus; it refreshes on git activity and file events. A custom panel rather than swapping workspace folders, because converting a single-folder window to multi-root restarts the extension host.

**Branches** panel (separate): every branch — local, remote, PR-only — newest first, tagged with `worktree` / `PR #N` / `conflicts` / `remote` / `local only`. Create a worktree from any row (inline action); PR rows expand into read-only file diffs; click a row with a worktree to focus it.

Selection is persisted per workspace. Compare defaults to merge-base of the integration tip (not “must rebase” when main moves).

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
