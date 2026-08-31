---
name: git-workflow
description: Working in a repo managed by the Git Workflow VS Code extension — worktree-per-branch lanes, a derived preview branch that must not be committed to, and the `gw-lane` headless opt-in. Load BEFORE THE FIRST EDIT of any feature or fix (not just before git commands), and before creating or switching branches, committing, rebasing onto a base, deleting branches, or resolving conflicts — in any repo with linked git worktrees or a `focus-*` / `gw-lane` file in its git common dir.
---

# Working in a Git Workflow repo

[Git Workflow](https://github.com/gabeklein/git-workflow) models a repo as
**lanes** — one branch, one worktree, one base — and builds a derived
**preview** branch previewing what landing several lanes at once would
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
ls  "$dir/gw-lane"       2>/dev/null # the reliable "preview ON" signal
cat "$dir/focus-guard"   2>/dev/null # branch whose commits are refused
ls  "$dir"/focus-*       2>/dev/null # lane state, current or leftover
```

| Found | Tier | Applies |
|---|---|---|
| One worktree, no `focus-*` | **not this repo** | **nothing below — stop reading, work normally** |
| Worktrees, no `focus-*` | plain worktrees | §2–3 only; lanes/preview are inert |
| `focus-*`, no `gw-lane` | preview **off** | §2–3; lane files are leftover, leave them |
| `gw-lane` | preview **on** | all of it |

**`focus-base` is not the ON test** — it can exist and be empty, left from a
session where preview was turned off. `gw-lane` is written on enable and
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

**Preview on (`gw-lane` exists)? Never write in the root checkout at all.**
The root *is* the preview — that is the only place it can be — so it is derived:
`reset --hard` recreates it on every rebuild and a `pre-commit` hook refuses
commits there. Read it, run tests in it, nothing else. (§4.)

Preview off, the root is still the wrong home for a feature: it sits on the
base, so work written into it moves the base branch — surfaced as base drift
(`main · +N unpushed`) and measured against by every other lane. Use it only
for reading, running tests, and edits the user pointed at there.

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

## 4. Never commit on the preview branch  *(preview on)*

`preview/{base}` (sometimes `focus/working`) is **derived** — every rebuild
recreates it via `reset --hard` as base + each applied lane merged. A commit
there has no home, and the only rescue, Absorb, can aim only at the base, which
is wrong if the work belonged to a lane.

It lives in the **workspace root checkout and nowhere else**: preview mode is
the root switched onto that branch. The same branch checked out in a linked
worktree is somebody's manual `git switch` — the extension ignores it entirely
(not rebuilt, not guarded, not shown), so do not create one and do not describe
one as a preview.

A `pre-commit` hook refuses it. **Do not reach for `--no-verify`** — that is a
human's override. Check out the real lane, or ask for **Absorb Preview
Edits**.

Same for the files it owns: change them via `gw-lane`, never by hand, since
rebuilds hold `focus-working.lock` while rewriting them — `focus-applied`
(membership) · `focus-candidates` (merge ORDER) · `focus-excluded` ·
`focus-wip` · `focus-base` (pinned base) · `focus-guard`. `focus-status` is
the exception in the other direction: it is a *record* of the last rebuild,
rewritten by every one — read it, never write it (§8).

## 5. Joining the preview is deliberate — and yours to do  *(preview on)*

A worktree cut from the preview base is a **candidate** automatically;
nothing merges into anyone's preview until applied. A shared base says two lanes
*can* merge, not that they belong side by side.

```sh
"$dir/gw-lane" status     # how it last BUILT, then what is applied
"$dir/gw-lane" add        # current branch (or: add feat-x)
"$dir/gw-lane" remove     # out, and persistently kept out
```

Works with the editor closed, taking the same lock the rebuild does; in-editor
this is **Add to Preview** (`worktreeCompare.addToPreview`).

**You may add your own lane without asking** — that is what the CLI is for, and
you know whether the work is worth previewing. Two conditions: preview is on
(`gw-lane` exists), and you **say so in your report**, since the preview changed
and the row will not explain itself.

- Not because "it has no conflicts". A conflicting rebuild fails *without
  touching the checkout* and tags the lane, so clashes are the cheap, visible
  case. The question is whether the work belongs beside the others yet.
- Stay out while mid-refactor, deliberately broken, or exploring something that
  would clash. Being out costs nothing; the row stays visible.
- No `gw-lane` → preview is off. Do **not** hand-write `focus-applied` to
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

## 7. Deleting branches, and the folders they leave

`git branch -d` judges merged by ancestry, so it refuses squash-merged branches;
`-D` deletes unmerged work just as happily. **Never reach for `-D` to clean up.**
**Prune Landed Branches** proves landing three ways (ancestry, content,
reproducing the squash it landed as) and is revert-aware — ask for it. Without
the extension the reasoning holds but the tool does not: say a branch *looks*
landed and let the user decide.

The CHECKOUT is a separate question, and with the extension running it answers
itself: a landed lane's worktree is removed as soon as it holds nothing of its
own, keeping the ref. A row still under **Working** reading `landed · …` is one
it could not clear — uncommitted changes, a paused merge, a lock, a file open
in an editor, or ignored files it will not delete — so resolve the named thing
rather than forcing the removal. An ignored file only blocks when deleting it
would lose it: a symlink out of the checkout, a file the root checkout has byte
for byte, and generated things (`node_modules`, `dist`, `coverage`) all go with
the folder, and are named in the log. Never `rm -rf` a worktree (§3); `git
worktree remove` it, and let a dirty one alone until whoever owns those changes
has dealt with them.

**A landed lane's remote branch is usually gone**, deleted by the merge. That
does NOT delete your `origin/<name>` tracking ref — nothing prunes it unless
`fetch.prune` is set or something asks — so a branch listed as remote-only may
not exist. `git remote prune origin` (or `git fetch --prune`) is how you find
out; do it before telling anyone a branch is still published.

## 8. Preview conflicts, and what to tell the user  *(preview on)*

**Applied ≠ in the tree. Check before you trust the preview.**

```sh
"$dir/gw-lane" status         # leads with the last rebuild
"$dir/gw-lane" check          # exit 0 ok · 1 failed · 2 nothing to go on
"$dir/gw-lane" rebuild        # rebuild now, and wait for the answer
"$dir/gw-lane" refresh        # make the editor look again (see below)
cat "$dir/focus-status"       # the same record, raw
```

A failed rebuild never touches the checkout, so the tree on disk is the last
*good* chain — the lane that broke it, and everything merged after it, are
simply not there. `focus-applied` still lists them; that file is intent, not
outcome. Reading membership and stopping is how a lane's own author ends up
debugging a preview their work was never in, and "fixing" what never merged.

The record is `key: value` lines:

| Key | Means |
|---|---|
| `state:` | `ok` or `failed` |
| `code:` | why it failed — `conflict` · `dirty` · `unique` · `moved` · `error` |
| `lane:` | the lane it stopped on |
| `tree:` / `tree-current:` | lanes the checkout holds, and whether that is this build |
| `resolved:` | a lane the resolver settled — `lane-wins` means hunks were **dropped** |
| `next:` | the move that clears it |
| `tip:` | each lane's sha *at the time* — `gw-lane status` compares them and says which have moved since, i.e. which failures may already be dealt with |

No record, or `no rebuild recorded`, means nothing has rebuilt in this repo
(preview off, or the editor has not run one) — not that the preview is clean.
`check` says the same in an exit code, and answers **2** — never 0 — when the
record cannot speak for the repo as it is now.

### The failure names YOUR lane

Fix it. That is ordinary work on your own branch, not an intervention:

1. **Catch the lane up with its base**, in its own worktree, by §6's rules —
   rebase unpushed, merge the base into pushed, resolve there.
2. Or **take the lane out** (`gw-lane remove`): the rebuild stops failing
   immediately and nobody else's preview stays blocked while you work. Being
   out costs nothing (§5), and this is the right move when the fix is not
   quick.
3. **Report which you did.** The preview changed either way, and the row will
   not explain itself.

Then rebuild and confirm. `gw-lane rebuild` works with the editor closed: it
runs the same engine the sidebar runs, taking the same lock, so it is the real
rebuild rather than an approximation of one. With the editor open one also
happens on its own — the rebuild watches lane tips, so your catch-up commit
triggers one.

**Verify rather than predict.** `rebuild` waits for the answer and exits 0
built · 1 the rebuild failed · 2 it could not run at all (preview is off, the
settings or the runner are not recorded, another writer holds the lock).
Report what came back. Only a 2 justifies saying the fix is in and a rebuild
is still needed — and say which of those it was.

What is NOT yours to fix, whatever the record says:

- **Another lane.** Its worktree may be dirty or mid-rebase, and its author is
  the one who knows what the resolution should be. Say which lane and what
  `next:` advises.
- **The preview branch itself.** Never resolve there, never commit there
  (§4) — a conflict "fixed" on the preview is discarded by the next rebuild.
- `dirty` / `unique` codes: those are somebody's uncommitted or stranded work
  in the root checkout. Absorb is a human's call — report it.

Lanes may also be tagged `auto-resolved` (same-line clash resolved toward the
incoming lane, dropped hunks listed) or `conflict`. Fix these **on the lane** by
catching it up with the base — never on the preview branch, never by editing the
preview. Unchecking a lane restores the preview immediately.

Name a sidebar command **only when the extension is in play** — to a repo
without it, or someone on SSH, it is a phantom instruction. Otherwise describe
the git state.

| Situation | Tell them |
|---|---|
| Work stranded on the preview branch | **Absorb Preview Edits…** |
| Preview looks stale | **Rebuild Preview** |
| Lane conflicts with base | **Resolve Conflict with Base…** / **Catch Up with Base…** |
| Rebased a pushed lane | **Force Push (with lease)** — their call |
| Branch list has grown | **Prune Landed Branches** |
| Diagnosing anything | **Output → Git Workflow** (or `focus-status`, headless) |

**The editor keeps up by watching, so mostly you need do nothing.** Commits,
branches, rebases and worktree changes all move refs, which it notices within
a moment. What it cannot see is a file written into a checkout — nothing under
`.git` changed — so if a row disagrees with your terminal, `gw-lane refresh`
asks for a fresh look. It is a signal with no reply: report what you did, not
that the UI agrees.

**One writer at a time, and it may not be you.** Every writer — the sidebar,
`gw-lane`, a rebuild — takes the same lock, and it records its holder. So the
preview can change under you at any moment unless you are the one changing it,
and `gw-lane owner` is how you find out whether something is mid-write. Nothing
is resident: an operation runs, takes the lock, and exits.
