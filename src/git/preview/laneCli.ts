import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { commonDir, APPLIED_FILE, CANDIDATES_FILE, LOCK_DIR } from './lanes';
import { STATUS_FILE } from './statusFile';
import { RUNNER_FILE } from '../../cli/runner';
import { REFRESH_FILE } from '../refreshSignal';

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
# Drive the preview without VS Code: join, leave, rebuild, look.
#
#   gw-lane status           how the preview built, what is applied
#   gw-lane check            exit 0 ok · 1 failed · 2 nothing to go on
#   gw-lane rebuild          rebuild the preview now, here
#   gw-lane owner            who holds the preview lock, if anyone
#   gw-lane refresh          ask any editor watching to catch up now
#   gw-lane absorb           move work made HERE onto the base branch
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
owner="$lock/owner"
runner="$dir/${RUNNER_FILE}"
refresh="$dir/${REFRESH_FILE}"

# The rebuild holds this while it rewrites the same files. Wait a long way
# for it: a rebuild is seconds on a developer's machine and considerably
# more on a loaded one, and queuing behind it is the normal case rather
# than an error. Matches LOCK_WAIT_MS in laneLock.
take_lock() {
  n=0
  while [ $n -lt 300 ]; do
    if mkdir "$lock" 2>/dev/null; then
      printf 'pid: %s\nhost: %s\nstarted: %s\nop: %s\n' \
        "$$" "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "gw-lane $cmd" \
        > "$lock/owner" 2>/dev/null || true
      return 0
    fi
    n=$((n + 1))
    sleep 0.2
  done
  echo "preview is busy (lock held) — try again in a moment" >&2
  exit 1
}
drop_lock() { rm -f "$lock/owner" 2>/dev/null || true; rmdir "$lock" 2>/dev/null || true; }

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

# --- running an operation ------------------------------------------------
# The engine is a bundle the editor recorded a recipe for; this runs it in
# THIS process and waits. Exclusion is the lock the engine takes (which now
# records its holder — see laneLock), not a queue: two of these racing is
# one of them waiting. Exit 127 means there is nothing to run, which is
# different from an operation that ran and failed.
run_op() {
  [ -f "$runner" ] || return 127
  rnode=$(value "$runner" node)
  rscript=$(value "$runner" script)
  [ -n "$rnode" ] && [ -n "$rscript" ] && [ -f "$rscript" ] || return 127
  if [ -n "$2" ]; then
    ELECTRON_RUN_AS_NODE=1 "$rnode" "$rscript" --common "$dir" "$1" "$2"
  else
    ELECTRON_RUN_AS_NODE=1 "$rnode" "$rscript" --common "$dir" "$1"
  fi
}

if [ "$cmd" = "refresh" ]; then
  date -u +%Y-%m-%dT%H:%M:%SZ > "$refresh"
  echo "refresh requested — an editor watching this repo will catch up shortly"
  exit 0
fi

if [ "$cmd" = "owner" ]; then
  if [ ! -f "$owner" ]; then
    echo "nobody is writing the preview"
    exit 1
  fi
  opid=$(value "$owner" pid)
  ohost=$(value "$owner" host)
  what=$(value "$owner" op)
  # Another host's holder cannot be checked from here, so it is reported
  # as-is rather than guessed at: two writers is the failure this avoids.
  if [ "$ohost" != "$(hostname)" ] || kill -0 "$opid" 2>/dev/null; then
    echo "busy: $what (pid $opid on $ohost since $(value "$owner" started))"
    exit 0
  fi
  echo "stale lock: $what (pid $opid is gone) — the next writer sweeps it"
  exit 1
fi

if [ "$cmd" = "rebuild" ]; then
  # rc must be captured in the ELSE branch: after the fi, $? is the status
  # of the compound (zero when no branch ran), not of the condition.
  if run_op rebuild ""; then
    exit 0
  else
    rc=$?
  fi
  if [ $rc -eq 127 ]; then
    echo "no way to run a rebuild here (focus-runner missing) — is preview on, and has the editor opened this repo?" >&2
    exit 2
  fi
  exit $rc
fi

# Work made in the preview checkout belongs on a real branch. Absorb is
# the one move aimed at the BASE — the wrong destination for lane work,
# and the right one for a fix to the base itself found while reading the
# preview. The delta is taken against the merged tree, so lane content
# stays behind even in a file a lane also touched.
if [ "$cmd" = "absorb" ]; then
  case "$branch" in
    ""|--allow-added) ;;
    *) echo "usage: gw-lane absorb [--allow-added]" >&2; exit 2 ;;
  esac
  if run_op absorb "$branch"; then
    exit 0
  else
    rc=$?
  fi
  if [ $rc -eq 127 ]; then
    echo "no way to absorb here (focus-runner missing) — is preview on, and has the editor opened this repo?" >&2
    exit 2
  fi
  exit $rc
fi

if [ "$cmd" = "status" ]; then
  if [ -f "$owner" ]; then
    echo "writer: $(value "$owner" op) (pid $(value "$owner" pid) on $(value "$owner" host))"
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
    if run_op apply "$branch"; then
      rc=0
    else
      rc=$?
    fi
    if [ $rc -eq 0 ]; then
      :
    elif [ $rc -eq 127 ]; then
      # Nothing to run — do it here. The files and this lock are the
      # protocol; the bundle is only a faster way to reach the same code.
      take_lock
      add_line "$candidates" "$branch"
      add_line "$applied" "$branch"
      drop_line "$dir/focus-excluded" "$branch"
      drop_lock
      echo "$branch is in the preview"
    else
      exit 1
    fi
    ;;
  remove)
    if run_op remove "$branch"; then
      rc=0
    else
      rc=$?
    fi
    if [ $rc -eq 0 ]; then
      :
    elif [ $rc -eq 127 ]; then
      take_lock
      drop_line "$applied" "$branch"
      drop_line "$candidates" "$branch"
      # Persist the choice: an auto-membership pass would otherwise put the
      # row straight back.
      add_line "$dir/focus-excluded" "$branch"
      drop_lock
      echo "$branch is out of the preview"
    else
      exit 1
    fi
    ;;
  *)
    echo "usage: gw-lane <status|check|rebuild|absorb|refresh|owner|add|remove> [branch]" >&2
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
