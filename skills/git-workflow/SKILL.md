---
name: git-workflow
description: Working in a repo managed by the Git Workflow VS Code extension — worktree-per-branch lanes, a derived integration branch that must not be committed to, and the `gw-lane` headless opt-in. Load BEFORE THE FIRST EDIT of any feature or fix (not just before git commands), and before creating or switching branches, committing, rebasing onto a base, deleting branches, or resolving conflicts — in any repo with linked git worktrees or a `focus-*` / `gw-lane` file in its git common dir.
---

# Working in a Git Workflow repo

[Git Workflow](https://github.com/gabeklein/git-workflow) models a repo as
**lanes** — one branch, one worktree, one base — and builds a derived
**integration** branch previewing what landing several lanes at once would
produce. It is all plain git plus files in the git common dir, so it drives
headlessly; but what it owns is destroyed on every rebuild, so committing
there loses work.

## 1. Establish the tier before acting

Installed per machine, this skill loads in repos that have nothing to do with
the extension, where most of it is wrong.

```sh
dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit    # not a git repo
case "$dir" in /*) ;; *) dir="$PWD/$dir";; esac
git worktree list                    # >1 line = linked worktrees
ls  "$dir/gw-lane"       2>/dev/null # the reliable "integration ON" signal
cat "$dir/focus-guard"   2>/dev/null # branch whose commits are refused
ls  "$dir"/focus-*       2>/dev/null # lane state, current or leftover
```

| Found | Tier | Applies |
|---|---|---|
| One worktree, no `focus-*` | **not this repo** | **nothing below — stop reading, work normally** |
| Worktrees, no `focus-*` | plain worktrees | §2–3 only; lanes/preview are inert |
| `focus-*`, no `gw-lane` | integration **off** | §2–3; lane files are leftover, leave them |
| `gw-lane` | integration **on** | all of it |

**`focus-base` is not the ON test** — it can exist and be empty, left from a
session where integration was turned off. `gw-lane` is written on enable and
removed on disable, so it tracks reality.

**Not a lane repo?** Work the way the repo already works, silently.
- Do not introduce the worktree workflow. Branching in place is right in most
  repos; a stray `.worktrees/` is a mess you made, not a convention you followed.
- Do not create `focus-*`, install hooks, or suggest installing the extension.
  A skill loading is not a request to adopt a workflow.
- Never describe the extension as running. No `gw-lane`, no `focus-*` → no
  evidence a preview exists, and saying a lane is "in the preview" invents one.

**Editor closed?** Everything here is git + files, so it works headlessly by
design. Only §8's commands degrade — prefer the shell equivalent, and name a
command only as the thing to do back in the editor.

## 2. Pick the lane before you write

**The first edit decides where the work lives.** By commit time the change is
already in whatever checkout you stood in — usually the root, usually on the
base — and moving it is a manual copy-and-revert nothing verifies.

> New feature or fix? Make the worktree, then work. Not after the edits.

Use the **root checkout** only for what belongs to it: reading, running tests,
edits the user pointed at there. The root sits on the base, so a feature written
into it moves the base branch — surfaced as base drift (`main · +N unpushed`)
and measured against by every other lane.

Started in the wrong place? Say so, then move it: create the lane, copy the
paths, **diff to prove they match**, then revert the originals. Never commit
"just this once" where you are.

## 3. Never switch a branch out from under a checkout

No `git checkout` / `git switch` to another branch in an existing worktree. Each
is someone's working surface, may be dirty, and its identity as a lane *is* the
branch it holds; switching silently retargets diffs, badges, and the preview.

```sh
git worktree add ../feat-x -b feat-x origin/main            # sibling layout
git worktree add .worktrees/feat-x -b feat-x origin/main    # watchFolders layout
```

`worktreeCompare.watchFolders` (default `.worktrees`) says where this repo puts
them, and the extension git-excludes that folder; discovery is `git worktree
list`, so anywhere works. Remove with `git worktree remove`, never `rm -rf`.

## 4. Never commit on the integration branch  *(integration on)*

`integration/{base}` (sometimes `focus/working`) is **derived** — every rebuild
recreates it via `reset --hard` as base + each applied lane merged. A commit
there has no home, and the only rescue, Absorb, can aim only at the base, which
is wrong if the work belonged to a lane.

A `pre-commit` hook refuses it. **Do not reach for `--no-verify`** — that is a
human's override. Check out the real lane, or ask for **Absorb Integration
Edits**.

Same for the files it owns: change them via `gw-lane`, never by hand, since
rebuilds hold `focus-working.lock` while rewriting them — `focus-applied`
(membership) · `focus-candidates` (merge ORDER) · `focus-excluded` ·
`focus-wip` · `focus-base` (pinned base) · `focus-guard`.

## 5. Joining the preview is deliberate — and yours to do  *(integration on)*

A worktree cut from the integration base is a **candidate** automatically;
nothing merges into anyone's preview until applied. A shared base says two lanes
*can* merge, not that they belong side by side.

```sh
"$dir/gw-lane" status     # what is applied, and what could be
"$dir/gw-lane" add        # current branch (or: add feat-x)
"$dir/gw-lane" remove     # out, and persistently kept out
```

Works with the editor closed, taking the same lock the rebuild does; in-editor
this is **Add to Integration** (`worktreeCompare.addToIntegration`).

**You may add your own lane without asking** — that is what the CLI is for, and
you know whether the work is worth previewing. Two conditions: integration is on
(`gw-lane` exists), and you **say so in your report**, since the preview changed
and the row will not explain itself.

- Not because "it has no conflicts". A conflicting rebuild fails *without
  touching the checkout* and tags the lane, so clashes are the cheap, visible
  case. The question is whether the work belongs beside the others yet.
- Stay out while mid-refactor, deliberately broken, or exploring something that
  would clash. Being out costs nothing; the row stays visible.
- No `gw-lane` → integration is off. Do **not** hand-write `focus-applied` to
  simulate it; nothing will honour it.

## 6. Staying current with the base

Staleness is measured against the *lane's own* base, not `main` by habit — read
`branch.<name>.vscode-merge-base`, the reflog, or ask.

- **Rebase unpushed, merge the base into pushed** — the `auto` strategy; avoids
  rewriting published history.
- **Never force-push on your own initiative.** After rebasing a pushed branch,
  stop and say a force-push (with lease) is needed.
- **Never abort a rebase/merge you did not start** — a paused one in another
  worktree is someone's in-progress resolution.
- Refuse to start either on a dirty worktree; commit or stash first.
- A lane stacked on a squash-merged branch conflicts against work nobody
  disputes: rebase `--onto` to replay only what has not landed.

## 7. Deleting branches

`git branch -d` judges merged by ancestry, so it refuses squash-merged branches;
`-D` deletes unmerged work just as happily. **Never reach for `-D` to clean up.**
**Prune Landed Branches** proves landing three ways (ancestry, content,
reproducing the squash it landed as) and is revert-aware — ask for it. Without
the extension the reasoning holds but the tool does not: say a branch *looks*
landed and let the user decide.

## 8. Preview conflicts, and what to tell the user  *(integration on)*

The integration tree is a best-effort preview of unlanded work. Lanes may be
tagged `auto-resolved` (same-line clash resolved toward the incoming lane,
dropped hunks listed) or `conflict`. Fix these **on the lane** by catching it up
with the base — never on the integration branch, never by editing the preview. A
failed rebuild never touches the checkout, so unchecking a lane restores it.

Name a sidebar command **only when the extension is in play** — to a repo
without it, or someone on SSH, it is a phantom instruction. Otherwise describe
the git state.

| Situation | Tell them |
|---|---|
| Work stranded on the integration branch | **Absorb Integration Edits…** |
| Preview looks stale | **Rebuild Integration Worktree** |
| Lane conflicts with base | **Resolve Conflict with Base…** / **Catch Up with Base…** |
| Rebased a pushed lane | **Force Push (with lease)** — their call |
| Branch list has grown | **Prune Landed Branches** |
| Diagnosing anything | **Output → Git Workflow** |
