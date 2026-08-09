# Git Workflow

VS Code / Cursor extension that auto-discovers git worktrees (e.g. under `.claude/worktrees`) and surfaces a GitLens-style **Working Tree ↔ base ref** comparison with **editable** working-tree diffs.

## Develop

```bash
npm install
npm run watch   # or press F5 (starts watch via preLaunchTask)
```

1. Open this folder in VS Code / Cursor (on the machine that has the worktrees — e.g. Remote-SSH to the box with `~/Projects/vantagepost`).
2. **F5** → Extension Development Host.
3. Open a repo that has worktrees under a watched folder.
4. After source changes: save (esbuild rebuilds) → **Developer: Reload Window** in the host.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `worktreeCompare.watchFolders` | `[".claude/worktrees"]` | Folders to scan for linked worktrees |
| `worktreeCompare.includeRootCheckout` | `always` | `always` / `dirty` / `never` — main workspace checkout in the list |
| `worktreeCompare.defaultBaseRef` | `main` | Fallback when fork point cannot be inferred |
| `worktreeCompare.contentRefreshIntervalMs` | `3000` | Hot-follow poll of focused worktree (`0` = off). Also refreshes on save/create/delete under that worktree — **no** recursive `**/*` watchers. |
| `worktreeCompare.squashLayout` | `list` | Squashed files: `list` or `tree` |
| `worktreeCompare.contentRefreshIntervalMs` | `3000` | Poll expanded worktrees for agent writes (`0` = watchers only) |

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
▼ Worktrees (N)
  ● fix/foo                     ← click to focus
  ○ feat/bar
⚠ Behind origin/staging (N)     ← only if behind > 0
▼ Ahead (N commits)
  commits…
▼ Staged (N)                    ← hidden if empty
▼ Changes
▼ Squashed · N vs base
```

One tree. Behind is a root row above Ahead (hidden when zero).
Selection is persisted per workspace.

## Roadmap

- [x] Extension scaffold (TreeView shell, config, F5/watch)
- [x] Discover worktrees under watch folders
- [x] Compare Working Tree vs base (ahead/behind, commits, files)
- [x] Open diffs with real worktree file paths (editable)
- [x] QuickPick to change compare base ref
- [x] Infer fork point (reflog / vscode-merge-base / closest ancestor)
- [x] Branch name primary label; worktree dir secondary
- [x] Hot-follow agent writes (content watcher + poll on expanded trees)
- [x] SCM-like Staged / Changes + Squashed single tree
- [ ] Stage/unstage/commit actions (optional; agents usually commit)
- [ ] Two-view split (History | Changes) if single tree gets dense
- [ ] Editable commits via rebase on confirm
