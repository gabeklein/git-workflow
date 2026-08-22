# Git Workflow

VS Code / Cursor extension that auto-discovers git worktrees (e.g. under `.claude/worktrees`) and surfaces a GitLens-style **Working Tree ↔ base ref** comparison with **editable** working-tree diffs.

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

### Install notes

- VSIX path: `artifacts/git-workflow-<version>.vsix` (gitignored). Runtime bundle is `dist/` (packaged inside the VSIX).
- **Remote-SSH:** run install on the remote. The extension host does not use the client’s `~/.vscode/extensions` alone.
- **Cursor:** if `code` is missing, ensure `cursor` is on PATH, or set `VSCODE_CLI=/path/to/cursor`.
- Env overrides: `SKIP_CODE_CLI=1`, `SKIP_SERVER=1`.
- **PR features** need authenticated `gh` (`gh auth login`). Without it, worktree compare still works; Remote PRs / PR badges stay empty.
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
| `worktreeCompare.watchFolders` | `[".claude/worktrees"]` | Where new worktrees (PR checkouts) are created; discovery uses `git worktree list` |
| `worktreeCompare.includeRootCheckout` | `dirty` | `dirty` / `always` / `never` — root checkout in the list (hide when clean by default) |
| `worktreeCompare.defaultBaseRef` | `main` | Fallback when fork point cannot be inferred |
| `worktreeCompare.squashLayout` | `list` | Full Diff files: `list` or `tree` |
| `worktreeCompare.contentRefreshIntervalMs` | `0` | Idle poll (`0` = off, events only) |
| `worktreeCompare.contentRefreshActiveIntervalMs` | `2500` | Faster poll after a change (only if poll enabled) |
| `worktreeCompare.contentRefreshIdleAfterMs` | `20000` | Quiet time before poll relaxes (only if poll enabled) |
| `worktreeCompare.githubPullRequests` | `auto` | `auto` / `off` — PR badges, Remote PRs, needs `gh` |
| `worktreeCompare.remotePrLimit` | `30` | Max open PRs in Remote PRs section |
| `worktreeCompare.integrationBranch` | `focus/working` | Branch that opts a worktree into the integration overlay |
| `worktreeCompare.integrationAutoRebuild` | `true` | Rebuild the integration tree when base / lane tips move |

## Integration worktree (overlay)

Opt-in: check out the integration branch (default `focus/working`) in a worktree —

```bash
git worktree add ../working -b focus/working main
```

That checkout is never worked in directly. It is rebuilt as **base + `merge --no-ff` of each applied lane**, so you can run/test any combination of feature branches together while each branch stays clean.

- **Apply to Integration** on a worktree row adds its branch as a lane and rebuilds; **Hide from Integration** drops it.
- With `integrationAutoRebuild` on, committing (or amending / rebasing) on an applied lane rebuilds the tree automatically — no git hooks needed. Change detection is event-driven: Node `fs.watch` on each repo's `.git` (`refs/`, `logs/`, `worktrees/`, `packed-refs` — never `objects/`, and not the VS Code host watcher), with a slow 30s poll as fallback for filesystems that drop events; if watch setup fails entirely, the poll runs at 4s.
- Guard rails: a rebuild refuses when the integration tree is dirty or carries commits that belong to no lane. A conflicting lane leaves the tree mid-merge with a warning on the row — resolve it there or run **Abort Integration Merge**.
- Lanes live in `<git-common-dir>/focus-applied` and rebuilds take `<git-common-dir>/focus-working.lock` — the same protocol as agent-focus's `scripts/focus-working.sh`, so the script, its `post-commit` hook, and this extension can be mixed freely.

## Base ref inference

When you expand a worktree, the compare base is resolved in order:

1. Manual override (Change Base Ref)
2. `branch.<name>.vscode-merge-base` (and similar config keys)
3. Reflog `Created from <ref>` / `checkout: moving from <ref>` (e.g. `origin/staging`)
4. `@{upstream}` only when it is **not** the same feature branch on a remote
5. Closest ancestor among `main` / `staging` / `develop` / … (prefers `origin/*`)
6. Configured default

Picking a bare local name like `staging` upgrades to `origin/staging` when that remote-tracking ref exists (local integration branches are often stale).

Check **Output → Git Workflow** for lines like `Inferred base for …`.

## Sidebar layout

**Worktree** panel:

```
▼ <selected-branch>                 description: · N worktrees
  branch rows (PR / pushed / local)  ← click to focus
⚠ PR #N has merge conflicts          ← GitHub conflicts only
▼ Commits · N                        description: → base [@sha]
▼ Staged / Unstaged                  ← hidden if empty; commit via context menu
▶ Full Diff · N new · M modified · …  ← collapsed until opened
```

**Remote PRs** panel (separate): open PRs without a local worktree; expand for read-only files; context menu to create a worktree.

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
