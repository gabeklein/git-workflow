import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { commonDir, APPLIED_FILE, CANDIDATES_FILE, LOCK_DIR } from './lanes';

/**
 * A headless way to join or leave the preview.
 *
 * Inclusion is deliberate now: a lane is a candidate automatically but
 * never applied on its own, because a base match says two lanes CAN merge,
 * not that they belong in the same preview. That decision belongs to
 * whoever is doing the work — increasingly an agent, which is exactly the
 * party that cannot reach a VS Code command. Without a headless surface,
 * opt-in means the preview simply stays empty.
 *
 * Installed into the git COMMON dir alongside the state it edits, on the
 * same lifecycle as the commit guard: written when preview goes on,
 * removed when it goes off. That keeps it untracked, per-repo, refreshed
 * on every enable, and — unlike a path inside the extension install
 * directory — at an address that survives the extension updating.
 *
 * It speaks the documented protocol directly (plain files plus the mkdir
 * lock), so it does not care whether VS Code is running.
 */

const LANE_CLI = 'gw-lane';

const SENTINEL = '# git-workflow: lane CLI';

const SCRIPT = `#!/bin/sh
${SENTINEL}
#
# Join or leave the preview preview, without VS Code.
#
#   gw-lane status           what is applied, and what could be
#   gw-lane add <branch>     include <branch> in the preview
#   gw-lane remove <branch>  take it out, and keep it out
#
# Managed by the Git Workflow extension: rewritten when preview is
# enabled, removed when it is disabled.

set -e
dir=$(git rev-parse --git-common-dir 2>/dev/null) || {
  echo "not a git repository" >&2; exit 1
}
case "$dir" in /*) ;; *) dir="$(pwd)/$dir" ;; esac

applied="$dir/${APPLIED_FILE}"
candidates="$dir/${CANDIDATES_FILE}"
lock="$dir/${LOCK_DIR}"

# The rebuild holds this while it rewrites the same files. It is held for
# a second or two at most, so wait for it rather than failing.
take_lock() {
  n=0
  while [ $n -lt 50 ]; do
    if mkdir "$lock" 2>/dev/null; then
      return 0
    fi
    n=$((n + 1))
    sleep 0.2
  done
  echo "preview is busy (lock held) — try again in a moment" >&2
  exit 1
}
drop_lock() { rmdir "$lock" 2>/dev/null || true; }

has_line() { [ -f "$1" ] && grep -qxF "$2" "$1"; }
# Append, never sort: the order lanes were added is the order they merge.
add_line() { has_line "$1" "$2" || printf '%s\\n' "$2" >> "$1"; }
drop_line() {
  [ -f "$1" ] || return 0
  grep -vxF "$2" "$1" > "$1.tmp" 2>/dev/null || : > "$1.tmp"
  mv "$1.tmp" "$1"
}

cmd="\${1:-status}"
branch="\${2:-}"

if [ "$cmd" = "status" ]; then
  echo "applied:"
  [ -s "$applied" ] && sed 's/^/  /' "$applied" || echo "  (none)"
  echo "candidates:"
  [ -s "$candidates" ] && sed 's/^/  /' "$candidates" || echo "  (none)"
  exit 0
fi

if [ -z "$branch" ]; then
  branch=$(git symbolic-ref --short HEAD 2>/dev/null) || {
    echo "usage: gw-lane $cmd <branch>" >&2; exit 2
  }
fi
if ! git rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
  echo "no such branch: $branch" >&2
  exit 2
fi

case "$cmd" in
  add)
    take_lock
    add_line "$candidates" "$branch"
    add_line "$applied" "$branch"
    drop_line "$dir/focus-excluded" "$branch"
    drop_lock
    echo "$branch is in the preview"
    ;;
  remove)
    take_lock
    drop_line "$applied" "$branch"
    drop_line "$candidates" "$branch"
    # Persist the choice: an auto-membership pass would otherwise put the
    # row straight back.
    add_line "$dir/focus-excluded" "$branch"
    drop_lock
    echo "$branch is out of the preview"
    ;;
  *)
    echo "usage: gw-lane <status|add|remove> [branch]" >&2
    exit 2
    ;;
esac
`;

async function read(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Absolute path agents should be pointed at. */
export async function laneCliPath(cwd: string): Promise<string> {
  return path.join(await commonDir(cwd), LANE_CLI);
}

export async function installLaneCli(cwd: string): Promise<boolean> {
  const target = await laneCliPath(cwd);
  if ((await read(target)) === SCRIPT) return false;
  await fs.writeFile(target, SCRIPT, { mode: 0o755 });
  // writeFile does not chmod a file that already existed
  await fs.chmod(target, 0o755);
  return true;
}

/** Remove it — but never something at that path we did not write. */
export async function uninstallLaneCli(cwd: string): Promise<void> {
  const target = await laneCliPath(cwd);
  const existing = await read(target);
  if (existing?.includes(SENTINEL)) await fs.rm(target, { force: true });
}
