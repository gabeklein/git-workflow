# Worktree Compare

VS Code extension that auto-discovers git worktrees (e.g. under `.claude/worktrees`) and surfaces a GitLens-style **Working Tree ↔ base ref** comparison with **editable** working-tree diffs.

## Develop

```bash
npm install
npm run watch   # or press F5 (starts watch via preLaunchTask)
```

1. Open this folder in VS Code / Cursor.
2. **F5** → Extension Development Host.
3. Open a repo that has worktrees under a watched folder.
4. After source changes: save (esbuild rebuilds) → **Developer: Reload Window** in the host.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `worktreeCompare.watchFolders` | `[".claude/worktrees"]` | Folders to scan for worktrees |
| `worktreeCompare.defaultBaseRef` | `main` | Fallback compare base |

## Roadmap

- [x] Extension scaffold (TreeView shell, config, F5/watch)
- [x] Discover worktrees under watch folders
- [x] Compare Working Tree vs base (ahead/behind, commits, files)
- [x] Open diffs with real worktree file paths (editable)
- [ ] QuickPick to change compare base ref
- [ ] Multi-select / stage-style actions on files
