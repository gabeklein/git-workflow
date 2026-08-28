---
name: git-workflow
description: How to work in a repo managed by the Git Workflow VS Code extension — worktree-per-branch lanes, an integration preview branch that is derived and must not be committed to, and the `gw-lane` headless opt-in. Load this BEFORE THE FIRST EDIT of any new feature or fix — not just before git commands — and before creating or switching branches, committing, rebasing onto a base, deleting branches, or resolving conflicts, in any repo that has linked git worktrees or a `focus-*` / `gw-lane` file in its git common dir.
---

# Working in a Git Workflow repo

The [Git Workflow](https://github.com/gabeklein/git-workflow) extension models a
repo as **lanes**: one branch, one worktree, one base ref. A derived
**integration** branch previews what landing several lanes at once would
produce. Almost everything it manages is plain git plus a few files in the git
common dir, so you can drive it headlessly — but a handful of things it owns are
destroyed on every rebuild, and committing into them loses work.

None of that is true of an ordinary repo, and this skill may well have loaded in
one. Check first; the rules below assume evidence you have not gathered yet.

## First: find out how much of this applies

This skill is usually installed per machine, so it will load in repos that have
nothing to do with the extension. **Most of it is then wrong.** Establish which
tier you are in before acting on anything below:

```sh
dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit   # not a git repo at all
case "$dir" in /*) ;; *) dir="$PWD/$dir";; esac
git worktree list                       # >1 line = linked worktrees exist
ls    "$dir/gw-lane"    2>/dev/null     # the reliable "integration is ON" signal
cat   "$dir/focus-guard" 2>/dev/null    # branch whose commits are refused
cat   "$dir/focus-base"  2>/dev/null    # pinned base sha (may exist but be EMPTY)
ls    "$dir"/focus-*     2>/dev/null    # lane state, current or leftover
```

| What you find | Tier | What applies |
|---|---|---|
| One worktree, no `focus-*` | **Not this repo** | **Nothing below.** Stop reading and work normally. |
| Linked worktrees, no `focus-*` | Plain worktrees | Worktree hygiene only — the lane/preview half is inert |
| `focus-*` present, no `gw-lane` | Integration **off** | Worktree hygiene; lane files are leftover, leave them alone |
| `gw-lane` present | Integration **on** | All of it |

**Do not test integration by the presence of `focus-base` alone.** It can exist
and be empty — leftover state from a session where integration was on and then
turned off. `gw-lane` is written when integration is enabled and removed when it
is disabled, so it is the signal that tracks reality.

### If this is not a lane repo

Say nothing about it and work the way the repo already works. In particular:

- **Do not introduce the worktree workflow to a repo that does not use it.**
  Branching in place is correct in most repos, and a stray `.worktrees/` folder
  in someone's project is a mess you made, not a convention you followed.
- Do not create `focus-*` files, install hooks, or suggest installing the
  extension unless asked. A skill loading is not a request to adopt a workflow.
- Never describe the extension as if it is running. If you have not seen
  `gw-lane` or a `focus-*` file, you have no evidence a preview exists, and
  telling the user their lane is "in the preview" would be an invention.

### If the extension is installed but the editor is not open

Everything here is plain git plus files in the git common dir, so it all works
headlessly — that is the design. The one part that degrades is the command
table at the end: naming a menu item is useless to someone on SSH. Prefer the
shell equivalent where one exists (`gw-lane`, `git worktree`), and name the
command only as the thing to do back in the editor.

## Pick the lane before you write, not before you commit

**The first edit decides where the work lives.** By the time there is
something to commit, the change is already in whatever checkout you were
standing in — usually the workspace root, usually on the base branch — and
moving it out is a manual copy-and-revert that nothing verifies for you. So the
worktree decision comes *first*, ahead of the first file you touch:

> Is this a new feature or fix? → make the worktree, work in it. Not after the
> edits, not at commit time.

Work in the **root checkout** only for things that genuinely belong to the
checkout you are in: reading, running tests, and edits the user pointed you at
there. The root is normally sitting on the base, so writing a feature into it
does not just misplace the work — it moves the base branch, which the extension
surfaces as base drift (a `main · +N unpushed` row in the preview) and which
every other lane is measured against.

If you notice you have already started in the wrong place, say so, then move it:
create the lane, copy the paths across, **diff them to prove they match**, and
only then revert the originals. Do not commit "just this once" where you are.

## Bias to worktrees, hard

**Do not `git checkout` / `git switch` another branch in an existing checkout.**
Each worktree is somebody's (or some agent's) working surface, may be dirty, and
its identity as a lane *is* the branch it holds. Switching it silently retargets
diffs, badges, and possibly the integration preview.

Start new work as a new worktree instead:

```sh
git worktree add ../feat-x -b feat-x origin/main     # sibling layout
git worktree add .worktrees/feat-x -b feat-x origin/main   # watchFolders layout
```

Check `worktreeCompare.watchFolders` (default `.worktrees`) for where this repo
puts them; the extension excludes that folder from git for you. Discovery is by
`git worktree list`, so anywhere on disk works. Remove a lane with
`git worktree remove`, never `rm -rf`.

## Never commit on the integration branch  *(integration on)*

The integration branch (default `integration/{base}`, sometimes
`focus/working`) is **derived**: every rebuild recreates it with `reset --hard`
as base + a merge of each applied lane. A commit made there has no home and the
only rescue — Absorb — can only aim at the base, which is wrong if the work
belonged to a lane.

A `pre-commit` hook refuses these commits. **If a commit is refused, do not
reach for `--no-verify`.** Check out the real lane and commit there, or ask the
user to run **Absorb Integration Edits**. `--no-verify` is a human's override,
not yours.

The same goes for the files the extension owns in the git common dir — edit them
through `gw-lane`, not by hand, because rebuilds hold `focus-working.lock` while
rewriting them:

`focus-applied` (membership) · `focus-candidates` (merge ORDER) ·
`focus-excluded` · `focus-wip` · `focus-base` (pinned base) ·
`focus-guard` · `focus-working.lock`

## Joining the preview is deliberate — and yours to do  *(integration on)*

A worktree cut from the integration base becomes a **candidate** automatically,
but nothing of yours merges into anyone's preview until it is applied. That is
the point: a shared base says two lanes *can* merge, not that they belong side
by side. Opt in once the work is worth previewing:

```sh
"$dir/gw-lane" status            # what is applied, and what could be
"$dir/gw-lane" add               # current branch into the preview
"$dir/gw-lane" add feat-x
"$dir/gw-lane" remove            # out, and persistently kept out
```

It works with the editor closed and takes the same lock the rebuild does. In the
editor the equivalent is **Git Workflow: Add to Integration**
(`worktreeCompare.addToIntegration`).

**You may add your own lane without asking** — that is what the CLI is for, and
the party doing the work is the one who knows whether it is worth previewing.
Two conditions: integration is actually on (`gw-lane` exists), and you **say so
in your report**, since the user's preview changed and the row will not explain
itself.

Do not use "it has no conflicts" as the reason. Conflicts are not the risk the
opt-in guards — a rebuild that hits one fails *without touching the checkout*
and tags the lane, so a clash is visible and cheap. The question is whether this
work belongs beside the others yet.

Leave a lane **out** while it is mid-refactor, deliberately broken, or exploring
something that would clash. Being out costs nothing; the row stays visible.

If `gw-lane` is missing, integration is off in this repo — do **not** hand-write
`focus-applied` to simulate it. Those files are read under a lock and a preview
that is off has no rebuild to honour them.

## Staying current with the base

Lane staleness is measured against that lane's own base, not `main` by habit —
read it from `branch.<name>.vscode-merge-base`, the reflog, or ask.

- Prefer **rebase for unpushed** lanes, **merge the base in** for pushed ones.
  That is what the extension's `auto` strategy does, and it avoids rewriting
  published history.
- **Never force-push on your own initiative.** After rebasing a pushed branch,
  stop and tell the user a force-push (with lease) is needed.
- Never `git rebase --abort` / `--merge --abort` on an operation you did not
  start — a paused rebase in another worktree is someone's in-progress conflict
  resolution.
- Refuse to start a rebase/merge on a dirty worktree; commit or stash first.
- A lane stacked on a branch that was squash-merged will conflict against work
  nobody disputes. Rebase with `--onto` to replay only what has not landed,
  rather than fighting the conflicts.

## Deleting branches

`git branch -d` decides "merged" by ancestry, so it refuses squash-merged
branches, and `-D` will happily delete unmerged work. **Do not reach for `-D` to
clean up.** The extension's **Prune Landed Branches** proves a branch landed
three ways (ancestry, content, reproducing the squash it landed as) and is
revert-aware. Ask for it rather than deleting by hand.

Without the extension the reasoning still holds, but the tool does not exist:
say the branch *looks* landed and let the user decide, rather than reaching for
`-D` because nothing stopped you.

## Conflicts in the preview are not real conflicts  *(integration on)*

The integration tree is a *best-effort preview of unlanded work*. Rows may be
tagged `auto-resolved` (a same-line clash resolved toward the incoming lane,
with the dropped hunks listed) or `conflict`. Fix these on the **lane**, by
catching it up with the base — not on the integration branch, and not by
editing the preview. A rebuild failure never touches the checkout, so an
unchecked lane restores a working preview immediately.

## Reporting to the user

**Only when the extension is actually in play.** These are sidebar commands;
naming one at a repo that does not have the extension — or at someone working
over SSH with no editor open — is noise at best and a phantom instruction at
worst. When in doubt, describe the git state and let the user find their own way
to it.

| Situation | Tell them |
|---|---|
| Work stranded on the integration branch | **Absorb Integration Edits…** |
| Preview looks stale | **Rebuild Integration Worktree** |
| Lane conflicts with base | **Resolve Conflict with Base…** / **Catch Up with Base…** |
| Rebased a pushed lane | **Force Push (with lease)** — their call |
| Branch list has grown | **Prune Landed Branches** |
| Diagnosing anything | **Output → Git Workflow** |

## Quick rules

0. Check the tier first. No `focus-*` and no linked worktrees → none of this
   applies; do not import the workflow into a repo that does not use it.
1. Decide the worktree **before the first edit**, not at commit time. Never
   switch a branch out from under an existing checkout.
2. Never commit on the integration branch; never `--no-verify` past the guard.
3. Never hand-edit `focus-*`; use `gw-lane`.
4. You may join the preview yourself — deliberately, and say so when you do.
5. Never force-push or `branch -D` without being asked.
6. Never abort a rebase or merge you did not start.
