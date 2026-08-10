# Git Workflow

VS Code / Cursor extension that auto-discovers git worktrees (e.g. under `.claude/worktrees`) and surfaces a GitLens-style **Working Tree ↔ base ref** comparison with **editable** working-tree diffs.

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

## Install for daily use (other projects)

Use this when you want **Git Workflow** in normal VS Code windows (not F5), including other repos on the same machine / Remote-SSH host.

```bash
# From this repo — build, package VSIX, install locally + mirror to vscode-server
npm run install:local
```

Then **Developer: Reload Window** (or reconnect the SSH remote) in the windows where you want the new build.

| Script | What it does |
|--------|----------------|
| `npm run package` | Production `dist/` only |
| `npm run vsix` | Production build + `.vsix` file |
| `npm run install:local` | Build → VSIX → `code --install-extension` → copy into `~/.vscode-server/extensions` and register `extensions.json` |

### Notes

- Extension id: **`local.git-workflow`** (from `publisher` + `name` in `package.json`).
- VSIX path: `git-workflow-<version>.vsix` (gitignored).
- **Remote-SSH:** the extension host runs on the remote. `install:local` installs under `~/.vscode/extensions` *and* mirrors to `~/.vscode-server/extensions` so remote windows see it. Run the script **on the remote** (or wherever the worktrees live).
- **Updates:** re-run `npm run install:local` after changes. Prefer bumping `"version"` in `package.json` when shipping a batch so VS Code clearly replaces the previous install.
- **Dev vs installed:** F5 EDH keeps using the project tree; normal windows use the installed copy. No need to uninstall while debugging.
- Env overrides: `SKIP_CODE_CLI=1` (skip `code --install-extension`), `SKIP_SERVER=1` (skip vscode-server mirror).

Manual alternative:

```bash
npm run vsix
code --install-extension ./git-workflow-0.0.1.vsix --force
# Reload window
```

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `worktreeCompare.watchFolders` | `[".claude/worktrees"]` | Folders to scan for linked worktrees |
| `worktreeCompare.includeRootCheckout` | `dirty` | `dirty` / `always` / `never` — root checkout in the list (hide when clean by default) |
| `worktreeCompare.defaultBaseRef` | `main` | Fallback when fork point cannot be inferred |
| `worktreeCompare.squashLayout` | `list` | Full Diff files: `list` or `tree` |
| `worktreeCompare.contentRefreshIntervalMs` | `0` | Idle poll (`0` = off, events only) |
| `worktreeCompare.contentRefreshActiveIntervalMs` | `2500` | Faster poll after a change (only if poll enabled) |
| `worktreeCompare.contentRefreshIdleAfterMs` | `20000` | Quiet time before poll relaxes (only if poll enabled) |
| `worktreeCompare.githubPullRequests` | `auto` | `auto` / `off` — PR badges, Remote PRs, needs `gh` |
| `worktreeCompare.remotePrLimit` | `30` | Max open PRs in Remote PRs section |

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

## Sidebar layout (single TreeView)

```
▼ <selected-branch> · N worktrees
  branch rows (PR / lock icons)   ← click to focus
⚠ PR #N has merge conflicts       ← GitHub conflicts only
▼ Ahead · N commits → base[@sha]
▼ Staged / Changes                ← hidden if empty
▼ Full Diff · N new · M modified · …
▼ Remote PRs · N open             ← no local worktree yet; expand = RO review
```

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
