import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { commonDir, APPLIED_FILE, CANDIDATES_FILE, LOCK_DIR } from './lanes';
import { STATUS_FILE } from './statusFile';
import { DAEMON_CMD_FILE, DAEMON_LOCK, QUEUE_DIR } from '../../daemon/protocol';

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
#   gw-lane status           how the preview built, what is applied
#   gw-lane check            exit 0 ok · 1 failed · 2 nothing to go on
#   gw-lane rebuild          ask the daemon to rebuild, and wait for it
#   gw-lane owner            who is serving this repo, if anyone
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
built="$dir/${STATUS_FILE}"
lock="$dir/${LOCK_DIR}"
queue="$dir/${QUEUE_DIR}"
claim="$dir/${DAEMON_LOCK}"
owner="$claim/owner"
daemon_cmd="$dir/${DAEMON_CMD_FILE}"

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

# Lanes whose tip has moved since the recorded rebuild ran. A conflict
# that was already dealt with reads exactly like a live one otherwise,
# and acting on a stale one means fixing something that never broke.
moved_list() {
  [ -f "$built" ] || return 0
  out=""
  while read -r key name sha rest; do
    [ "$key" = "tip:" ] || continue
    now=$(git rev-parse -q --verify "refs/heads/$name^{commit}" 2>/dev/null) || now="gone"
    [ "$now" = "$sha" ] || out="$out $name"
  done < "$built"
  printf '%s' "$out"
}

field() { sed -n "s/^$1: //p" "$built" 2>/dev/null | head -1; }
value() { sed -n "s/^$2: //p" "$1" 2>/dev/null | head -1; }

# Is somebody serving this repo? A claim from ANOTHER host is honoured
# blind: we cannot read its process table, and guessing wrong would mean
# two writers, which is the one thing the queue exists to prevent.
daemon_alive() {
  [ -f "$owner" ] || return 1
  opid=$(value "$owner" pid)
  ohost=$(value "$owner" host)
  [ -n "$opid" ] || return 1
  if [ -n "$ohost" ] && [ "$ohost" != "$(hostname)" ]; then
    return 0
  fi
  kill -0 "$opid" 2>/dev/null
}

# Start one. Safe to call when another is already running: the loser of
# the claim exits immediately, so a race costs a process that lives for a
# few milliseconds rather than a lock nobody can resolve.
spawn_daemon() {
  [ -f "$daemon_cmd" ] || return 1
  dnode=$(value "$daemon_cmd" node)
  dscript=$(value "$daemon_cmd" script)
  [ -n "$dnode" ] && [ -n "$dscript" ] && [ -f "$dscript" ] || return 1
  ELECTRON_RUN_AS_NODE=1 nohup "$dnode" "$dscript" --common "$dir" \
    >/dev/null 2>&1 &
  n=0
  while [ $n -lt 50 ]; do
    daemon_alive && return 0
    n=$((n + 1))
    sleep 0.1
  done
  return 1
}

# Write, then rename: a request appears in req/ complete or not at all.
submit() {
  mkdir -p "$queue/tmp" "$queue/req" "$queue/res"
  id=$(basename "$(mktemp -u "$queue/tmp/XXXXXXXX")")
  printf 'op: %s\nreason: %s\nclient-pid: %s\nclient-host: %s\n' \
    "$1" "$2" "$$" "$(hostname)" > "$queue/tmp/$id"
  mv "$queue/tmp/$id" "$queue/req/$id"
  echo "$id"
}

# $1 = id, $2 = seconds to wait. Prints the answer; 1 if none came.
await() {
  n=0
  limit=$(( $2 * 10 ))
  while [ $n -lt $limit ]; do
    if [ -f "$queue/res/$1" ]; then
      cat "$queue/res/$1"
      rm -f "$queue/res/$1"
      return 0
    fi
    n=$((n + 1))
    sleep 0.1
  done
  return 1
}

if [ "$cmd" = "owner" ]; then
  if daemon_alive; then
    echo "serving: pid $(value "$owner" pid) on $(value "$owner" host) since $(value "$owner" started)"
    exit 0
  fi
  if [ -f "$owner" ]; then
    echo "stale claim: pid $(value "$owner" pid) on $(value "$owner" host) is gone (the next daemon sweeps it)"
  else
    echo "nobody is serving this repo"
  fi
  exit 1
fi

if [ "$cmd" = "rebuild" ]; then
  if ! daemon_alive; then
    if ! spawn_daemon; then
      echo "cannot reach or start a preview daemon (focus-daemon-cmd missing or unusable) — is preview on?" >&2
      exit 2
    fi
  fi
  id=$(submit rebuild "gw-lane (pid $$)")
  answer=$(await "$id" 180) || {
    echo "no answer in 180s — the daemon may still be working; try: gw-lane status" >&2
    exit 2
  }
  ok=$(echo "$answer" | sed -n 's/^ok: //p' | head -1)
  code=$(echo "$answer" | sed -n 's/^code: //p' | head -1)
  msg=$(echo "$answer" | sed -n 's/^message: //p' | head -1)
  if [ "$ok" = "yes" ]; then
    echo "rebuilt: $(echo "$answer" | sed -n 's/^tree: //p' | head -1)"
    exit 0
  fi
  if [ -n "$msg" ]; then
    echo "rebuild failed: $code — $msg" >&2
  else
    echo "rebuild failed: $code" >&2
  fi
  # Same three answers as check: a rebuild that never ran (no settings, an
  # op this daemon does not know) is not a failed preview.
  case "$code" in
    unconfigured|unsupported|busy) exit 2 ;;
    *) exit 1 ;;
  esac
fi

if [ "$cmd" = "status" ]; then
  if daemon_alive; then
    echo "daemon: serving (pid $(value "$owner" pid))"
  else
    echo "daemon: not running (started on demand)"
  fi
  # Build outcome FIRST: when it failed, the checkout still holds the last
  # good tree, so which lanes are "applied" is the less urgent fact.
  echo "last rebuild:"
  if [ -s "$built" ]; then
    grep -v '^#' "$built" | sed 's/^/  /'
    moved=$(moved_list)
    if [ -n "$moved" ]; then
      echo "  note: moved since this rebuild ran —$moved (rebuild to re-check)"
    fi
  else
    echo "  (no rebuild recorded — preview may be off, or VS Code has not run one)"
  fi
  echo "applied:"
  [ -s "$applied" ] && sed 's/^/  /' "$applied" || echo "  (none)"
  echo "candidates:"
  [ -s "$candidates" ] && sed 's/^/  /' "$candidates" || echo "  (none)"
  exit 0
fi

# One question, answered as an exit status: is the preview tree currently
# built from what is applied? Meant to be gated on — "status" stays exit 0
# because printing a report is not a failure.
if [ "$cmd" = "check" ]; then
  if [ ! -s "$built" ]; then
    echo "unknown: no rebuild recorded — preview may be off, or nothing has rebuilt yet"
    exit 2
  fi
  moved=$(moved_list)
  if [ -n "$moved" ]; then
    # The record no longer describes the repo, so it can answer neither
    # way. This is what an agent that just caught its lane up sees, and it
    # is the reason a fix does not read back as a live failure.
    echo "unknown: moved since this record —$moved (rebuild to re-check)"
    exit 2
  fi
  if [ "$(field state)" = "ok" ]; then
    echo "ok: preview holds $(field tree)"
    exit 0
  fi
  on=$(field lane)
  if [ -n "$on" ]; then on=" on lane $on"; fi
  echo "failed: $(field code)$on"
  detail=$(field detail)
  if [ -n "$detail" ]; then echo "  $detail"; fi
  step=$(field next)
  if [ -n "$step" ]; then echo "  next: $step"; fi
  exit 1
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
    echo "usage: gw-lane <status|check|rebuild|owner|add|remove> [branch]" >&2
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
