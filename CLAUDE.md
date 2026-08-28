# CLAUDE.md

**Read [AGENTS.md](AGENTS.md) before doing anything here.** It is the single
source of truth for working in this repo — testing policy, the EDH suite's
rules, commit conventions, and how integration mode changes what you may do.
This file exists only to point at it; nothing is duplicated here, so that the
two can never disagree.

## This repo runs its own extension

Git Workflow is developed here **and used here**. Its rules are not
hypothetical: there are linked worktrees under `.worktrees/`, integration mode
may be on, and a `pre-commit` hook will refuse a commit made on the derived
integration branch.

Before your first edit of any feature or fix, load the skill in
[`skills/git-workflow`](skills/git-workflow/SKILL.md). It is the same document
the extension points other repos at, it starts with a check for which of its
rules actually apply right now, and the short version is:

- **Pick the worktree before you write**, not at commit time. New feature or
  fix → `git worktree add`. Writing into the root checkout moves the base
  branch every other lane is measured against.
- **Never commit on the integration branch**, and never `--no-verify` past the
  guard when it refuses — it is refusing for a reason the message explains.
- **Never hand-edit `focus-*`** in the git common dir; use `gw-lane`.

## Keeping this current

The workflow is documented in three places on purpose, and they drift if you
let them: [AGENTS.md](AGENTS.md) (working here), the
[skill](skills/git-workflow/SKILL.md) (working in any repo the extension
manages), and [README.md](README.md) (what the extension does). A change to how
the workflow *behaves* belongs in all three.

Above all: a feature is not finished when it works. The extension exists to be
used by agents that will never read its source, so shipping one means asking
what an agent has to know to use it — and putting that where it will actually
be found: the skill, a refusal message, a command description.
