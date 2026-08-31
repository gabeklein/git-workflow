import * as path from 'node:path';
import * as vscode from 'vscode';
import { clearRunnerCommand, writeRunnerCommand } from '../cli/runner';
import { type LaneOpName, runLaneOp } from '../git/preview/laneOp';
import type { DiscoveredWorktree } from '../git/discovery';
import { findPreviewCheckout, orderLaneRows } from './lanesPlan';
import { git, gitOk } from '../git/exec';
import { revParseCommit } from '../git/plumbing';
import { baseMergeInProgress, fastForwardEmptyLane } from '../git/laneOps';
import { excludeWorkspaceSettings } from '../git/exclude';
import {
  absorbDirtyEdits,
  absorbStrayCommits,
  addedPathsInCommits,
  checkoutForBranch,
  clearBasePin,
  readBasePin,
  resolveBaseSha,
  writeBasePin,
  abortPreviewMerge,
  addExcludedLane,
  alignPreviewBranchName,
  installCommitGuard,
  installLaneCli,
  laneCliPath,
  isCommitGuardEnabled,
  clearPreviewSettings,
  clearPreviewStatus,
  commonDir,
  uninstallCommitGuard,
  uninstallLaneCli,
  writePreviewSettings,
  baseStatusFor,
  ensurePreviewPushBlocked,
  fetchPreviewBase,
  findLandedLanes,
  findStaleLandedLanes,
  findStrayCommits,
  previewBaseRef,
  previewBranch,
  previewFingerprint,
  isPreviewAutoRebuildEnabled,
  isPreviewAbsorbEnabled,
  isLaneBranch,
  laneNeverDiverged,
  listAppliedLanes,
  reorderLane as reorderLaneFile,
  dropExcludedLane,
  listCandidateLanes,
  listExcludedLanes,
  listWipLanes,
  pruneDeadLanes,
  rebuildFromSettings,
  setWipLane,
  type AbsorbResult,
  type AbsorbTarget,
  type RebuildResult,
  type ResolvedLane,
} from '../git/preview';
import { isPathInside, shouldIgnoreHotFollowPath } from './paths';

/** What the controller needs from its host (the tree provider). */
interface PreviewHost {
  readonly output: { appendLine(value: string): void };
  getWorktrees(): DiscoveredWorktree[];
  getRepoCwd(): string | undefined;
  getSelectedPath(): string | undefined;
  fireTreeData(): void;
  refresh(): void;
  refreshCompare(worktreePath: string): void;
  /** Selection landed on the preview checkout — move it to a real lane. */
  moveSelectionOff(worktreePath: string): void;
  /** Override ?? genuine inference for a worktree's base — undefined when
   *  there is no evidence (auto-membership must never enroll on a guess). */
  genuineBaseFor(worktreePath: string): Promise<string | undefined>;
  /** Where this extension is installed — the one-shot CLI bundle ships
   *  beside it, and the recipe has to name a real path. */
  extensionPath?(): string | undefined;
}

export interface PreviewState {
  path: string;
  branch: string;
  lanes: string[];
  candidates: string[];
  /** Explicitly-added candidates (focus-candidates file); the rest of the
   *  candidates are auto members (base matches) or script-applied lanes. */
  explicit: string[];
  wip: string[];
  landed: string[];
  /** Applied lanes whose tips conflict with the base (probed off-tree). */
  conflicts: string[];
  /** Candidates with a paused base merge in their worktree. */
  resolving: string[];
  /** Lanes whose conflicts the last rebuild's resolver settled. */
  autoResolved: ResolvedLane[];
  /** Local <base> carries commits the frozen base does not — offer
   *  Convert-to-Branch / Catch Up instead of silently retargeting. */
  baseDrift?: { ahead: number; sha: string; resetTo: string; included: boolean };
  /** A git merge is paused in the preview checkout itself (external
   *  script / by hand) — Abort Preview Merge only applies then. */
  mergePaused: boolean;
  error?: { code: string; message: string; lane?: string };
}

/**
 * Preview overlay (focus/working) state machine: detection, lane
 * files, auto-rebuild tick, wip-save reactivity, and the rebuild queue.
 * Owns no tree rendering — panels read getState().
 */
export class PreviewController implements vscode.Disposable {
  private previewPath: string | undefined;
  /** Path:branch:enabled the pre-commit guard was last reconciled for. */
  private guardSyncedFor: string | undefined;
  /** Base sha + lane set the stale-landing sweep last ran for. */
  private staleSweptFor: string | undefined;
  private lanes: string[] = [];
  /** Everything shown under Preview: explicit + applied + auto members. */
  private candidates: string[] = [];
  /** Explicitly-added candidates (focus-candidates file). */
  private explicit: string[] = [];
  /** Candidates whose tips are contained in the base (they landed). */
  private landed: string[] = [];
  /** Lanes whose uncommitted edits overlay into rebuilds. */
  private wip: string[] = [];
  /** Applied lanes whose tips conflict with the base right now. */
  private conflicts: string[] = [];
  /** Candidates with a paused base merge in their worktree. */
  private resolving: string[] = [];
  private mergePaused = false;
  /** Resolver outcomes from the last successful rebuild. */
  private autoResolved: ResolvedLane[] = [];
  private baseDrift:
    | { ahead: number; sha: string; resetTo: string; included: boolean }
    | undefined;
  /** Conflict-probe memo (refSha:baseSha) for the lane-vs-base re-probe. */
  private readonly probeMemo = new Map<string, boolean>();
  private error: { code: string; message: string; lane?: string } | undefined;
  private fingerprint: string | undefined;
  private rebuildInFlight = false;
  /** Reason of a rebuild requested while one was in flight — run once after. */
  private rebuildQueued: string | undefined;
  private wipDebounce: NodeJS.Timeout | undefined;
  /** Preview HEAD of the last auto-absorb attempt — one try per tip,
   *  so a target that keeps refusing never loops the rebuild queue. */
  private lastAbsorbHead: string | undefined;
  private lastBaseFetchAt = 0;

  constructor(private readonly host: PreviewHost) {}

  /** The preview and its lanes, if preview mode is on. */
  getState(): PreviewState | undefined {
    if (!this.previewPath) return undefined;
    return {
      path: this.previewPath,
      branch: previewBranch(),
      lanes: this.lanes.slice(),
      candidates: this.candidates.slice(),
      explicit: this.explicit.slice(),
      wip: this.wip.slice(),
      landed: this.landed.slice(),
      conflicts: this.conflicts.slice(),
      resolving: this.resolving.slice(),
      autoResolved: this.autoResolved.slice(),
      baseDrift: this.baseDrift,
      mergePaused: this.mergePaused,
      error: this.error,
    };
  }

  getPath(): string | undefined {
    return this.previewPath;
  }

  /**
   * Re-read everything the panel renders: which lanes exist, which are
   * applied, and every badge that hangs off them.
   *
   * Runs on every tick, so each step is a named step below rather than
   * inline — the sequence is the interesting part, and it matters: the
   * base pin has to be frozen before anything resolves against it, and
   * membership has to be settled before the badges that describe members.
   */
  async refreshState(): Promise<void> {
    const branch = previewBranch();
    const wt = findPreviewCheckout(this.host.getWorktrees(), branch);

    if (!wt) {
      this.forgetPreview(branch);
      return;
    }

    if (this.previewPath !== wt.path) this.adoptPreview(wt.path, branch);
    this.previewPath = wt.path;

    const guardKey = `${wt.path}:${branch}:${isCommitGuardEnabled()}`;
    if (this.guardSyncedFor !== guardKey) {
      this.guardSyncedFor = guardKey;
      void this.syncCommitGuard(wt.path, branch);
    }

    try {
      await this.dropDeadLanes(wt.path);
      await this.ensureBasePin(wt.path);

      const baseRef = previewBaseRef();
      const effective = await resolveBaseSha(wt.path, baseRef);
      this.baseDrift = await this.readBaseDrift(wt.path, effective);

      this.lanes = await listAppliedLanes(wt.path);
      const explicit = await listCandidateLanes(wt.path);
      this.explicit = explicit;
      const auto = await this.autoMembers(wt.path, explicit, effective);
      // Applied lanes (e.g. from the shell script) always show as candidates
      // One ordered list, checked or not: the candidate file IS the order,
      // so a toggle changes a checkbox and never moves a row.
      this.candidates = orderLaneRows(await listCandidateLanes(wt.path), [
        ...explicit,
        ...auto,
        ...this.lanes,
      ]);

      this.wip = await listWipLanes(wt.path);
      this.landed = await findLandedLanes(wt.path, baseRef, this.candidates);
      // Off the rebuild path, and throttled: catches a lane that landed
      // before the base moved on, which the cheap check above cannot see.
      void this.sweepStaleLandings(wt.path, baseRef);

      this.conflicts = await this.conflictedLanes(wt.path, baseRef);
      this.resolving = await this.resolvingLanes(wt.path);
      // MERGE_HEAD in the preview checkout itself (external script /
      // by hand) — gates the Abort Preview Merge menu item, which
      // otherwise showed permanently for a state the off-tree engine
      // can no longer produce.
      this.mergePaused = await baseMergeInProgress(wt.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`Read lanes failed: ${message}`);
      this.lanes = [];
      this.candidates = [];
      this.explicit = [];
      this.wip = [];
      this.landed = [];
      this.conflicts = [];
      this.resolving = [];
    }
  }

  /** The root checkout left the preview branch — drop overlay and guard. */
  private forgetPreview(branch: string): void {
    if (this.previewPath)
      this.host.output.appendLine('Root checkout left the preview branch — overlay off');
    if (this.guardSyncedFor) {
      this.guardSyncedFor = undefined;
      void this.syncCommitGuard(undefined, branch);
    }
    this.previewPath = undefined;
    this.lanes = [];
    this.candidates = [];
    this.explicit = [];
    this.landed = [];
    this.conflicts = [];
    this.resolving = [];
    this.autoResolved = [];
    this.baseDrift = undefined;
    this.mergePaused = false;
    this.error = undefined;
    this.fingerprint = undefined;
  }

  /** First sight of this preview checkout (enabled, moved, reloaded). */
  private adoptPreview(previewPath: string, branch: string): void {
    this.error = undefined;
    this.fingerprint = undefined;
    this.host.output.appendLine(
      `Preview: ${previewPath} (${branch})`,
    );
    // Covers checkouts created by the shell script or by hand too
    ensurePreviewPushBlocked(previewPath).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`Push-block config failed: ${message}`);
    });
    // The preview is the workspace root, so VS Code's own settings file
    // lands inside a derived tree — and an untracked file there is enough
    // to make every rebuild refuse as dirty.
    excludeWorkspaceSettings(previewPath).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`Excluding workspace settings failed: ${message}`);
    });
    // Enabling must not hijack the compare focus: if the selected
    // checkout just became the preview surface, move selection to a
    // real worktree. Explicit clicks on the Preview row still focus it.
    if (this.host.getSelectedPath() === previewPath)
      this.host.moveSelectionOff(previewPath);
  }

  /**
   * Dead lanes: a branch deleted out from under Preview (its worktree
   * died — landed and cleaned up, agent teardown) leaves ghost rows in the
   * lane files. Prune before reading, so a lane that no longer exists never
   * renders or re-enters a rebuild.
   */
  private async dropDeadLanes(previewPath: string): Promise<void> {
    const pruned = await pruneDeadLanes(previewPath);
    if (pruned.length > 0) {
      this.host.output.appendLine(
        `Preview lanes pruned (branch gone): ${pruned.join(', ')}`,
      );
    }
  }

  /**
   * Freeze the base on first sight of this preview checkout: the pin is
   * what rebuilds anchor to; only published (origin) movement or an explicit
   * Catch Up advances it. Enable/base-change clear it, so it re-pins fresh;
   * reloads keep it — that IS the freeze.
   */
  private async ensureBasePin(previewPath: string): Promise<void> {
    if (await readBasePin(previewPath)) return;
    // Pin at the PUBLISHED tip when one exists: if local <base> is
    // already ahead at first sight (commits made before preview
    // loaded), that segment is drift to SURFACE as a lane — not floor
    // to swallow. The descendant-preferring legacy resolution would
    // pin the drifted tip and hide it forever. No origin → local.
    const name = previewBaseRef().replace(/^origin\//, '');
    const fresh =
      (await revParseCommit(previewPath, `origin/${name}`)) ??
      (await revParseCommit(previewPath, `refs/heads/${name}`)) ??
      (await resolveBaseSha(previewPath, previewBaseRef()));
    if (!fresh) return;
    await writeBasePin(previewPath, fresh);
    this.host.output.appendLine(
      `Preview base pinned at ${fresh.slice(0, 10)} (${previewBaseRef()})`,
    );
  }

  /**
   * Drift: local <base> carries commits the frozen base does not — the panel
   * offers Convert-to-Branch / Catch Up instead of the preview silently
   * retargeting onto unpublished work.
   *
   * Returned rather than assigned, and assigned by the caller in one go:
   * blanking `baseDrift` up front left a transient no-drift window during
   * every refresh (row flicker, and readers mid-refresh saw undefined while
   * drift persisted).
   */
  private async readBaseDrift(
    previewPath: string,
    effective: string | undefined,
  ): Promise<
    { ahead: number; sha: string; resetTo: string; included: boolean } | undefined
  > {
    const baseName = previewBaseRef().replace(/^origin\//, '');
    const localSha = await revParseCommit(
      previewPath,
      `refs/heads/${baseName}`,
    );
    if (!effective || !localSha || localSha === effective) return undefined;
    const contained = await gitOk(previewPath, [
      'merge-base',
      '--is-ancestor',
      localSha,
      effective,
    ]);
    if (contained) return undefined;

    const ahead =
      Number(
        (
          await git(previewPath, [
            'rev-list',
            '--count',
            `${effective}..${localSha}`,
          ]).catch(() => '0')
        ).trim(),
      ) || 0;
    if (ahead === 0) return undefined;

    return {
      ahead,
      sha: localSha,
      resetTo: effective,
      // Included by default: unpushed base work is unlanded work, shown in
      // the preview like any lane. Uncheck persists the base name in
      // focus-excluded.
      included: !(await listExcludedLanes(previewPath)).includes(baseName),
    };
  }

  /**
   * Auto-membership: a worktree whose own base — override or GENUINE
   * inference, never the configured fallback — matches the preview base
   * is a candidate automatically. Stacked lanes (base = parent branch) stay
   * out, and so do branches whose base we merely guessed.
   */
  private async autoMembers(
    previewPath: string,
    explicit: string[],
    effective: string | undefined,
  ): Promise<string[]> {
    const excluded = await listExcludedLanes(previewPath);
    const integBase = previewBaseRef().replace(/^origin\//, '');
    const auto: string[] = [];

    for (const w of this.host.getWorktrees()) {
      if (
        w.detached ||
        w.path === previewPath ||
        explicit.includes(w.branch) ||
        this.lanes.includes(w.branch) ||
        excluded.includes(w.branch) ||
        !isLaneBranch(w.branch, previewBaseRef())
      ) {
        continue;
      }
      const base = await this.host.genuineBaseFor(w.path);
      if (!base || base.replace(/^origin\//, '') !== integBase) continue;
      auto.push(w.branch);
      await this.repointEmptyLane(previewPath, w, effective);
    }
    return auto;
  }

  /**
   * Empty lane (created off the base, nothing committed yet): keep it
   * pointed AT the base. It is not applied — being mergeable is not a reason
   * to be in someone's preview — it just starts from the right place when
   * its first commit lands.
   *
   * Cut from a stale base, the lane reads as "behind" while having nothing
   * to rebase. Re-point it instead — lossless, since it has no commits — so
   * its first commit starts from the CURRENT base.
   */
  private async repointEmptyLane(
    previewPath: string,
    lane: DiscoveredWorktree,
    effective: string | undefined,
  ): Promise<void> {
    const laneSha = await revParseCommit(
      previewPath,
      `refs/heads/${lane.branch}`,
    );
    if (!effective || !laneSha || laneSha === effective) return;
    const contained = await gitOk(previewPath, [
      'merge-base',
      '--is-ancestor',
      laneSha,
      effective,
    ]);
    if (!contained) return;
    if (!(await laneNeverDiverged(previewPath, laneSha, effective))) return;

    const ff = await fastForwardEmptyLane(lane.path, previewBaseRef());
    const integBase = previewBaseRef().replace(/^origin\//, '');
    this.host.output.appendLine(
      ff.status === 'done'
        ? `Empty lane ${lane.branch} fast-forwarded to ${integBase}`
        : `Empty lane ${lane.branch} left where it is (${ff.status}${
            'message' in ff ? `: ${ff.message}` : ''
          })`,
    );
  }

  /**
   * Persistent conflict badge: re-probe applied lanes against the base on
   * every refresh (memoized per tip pair), so 'conflict' and its Resolve
   * action survive window reloads instead of living only in post-rebuild
   * error memory.
   */
  private async conflictedLanes(
    previewPath: string,
    baseRef: string,
  ): Promise<string[]> {
    const conflicts: string[] = [];
    for (const lane of this.lanes) {
      if (this.landed.includes(lane)) continue;
      const st = await baseStatusFor(
        previewPath,
        `refs/heads/${lane}`,
        baseRef,
        this.probeMemo,
      );
      if (st?.conflicts) conflicts.push(lane);
    }
    return conflicts;
  }

  /**
   * Paused base merges in candidate checkouts (started here or in a
   * terminal) — the lane row shows Complete/Abort either way.
   */
  private async resolvingLanes(previewPath: string): Promise<string[]> {
    const resolving: string[] = [];
    for (const w of this.host.getWorktrees()) {
      if (
        !w.detached &&
        w.path !== previewPath &&
        this.candidates.includes(w.branch) &&
        (await baseMergeInProgress(w.path))
      ) {
        resolving.push(w.branch);
      }
    }
    return resolving;
  }

  /**
   * Wip lanes: a save/create/delete under an opted-in lane's checkout
   * (VS Code events only, per design) re-snapshots and rebuilds.
   */
  scheduleWipRebuildIfUnderWipLane(uri: vscode.Uri): void {
    if (uri.scheme !== 'file' || !this.previewPath) return;
    const wip = this.wip.filter((l) => this.lanes.includes(l));
    if (wip.length === 0) return;
    const hit = this.host
      .getWorktrees()
      .find(
        (w) =>
          !w.detached &&
          w.path !== this.previewPath &&
          wip.includes(w.branch) &&
          isPathInside(uri.fsPath, w.path),
      );
    if (!hit || shouldIgnoreHotFollowPath(uri.fsPath, hit.path)) return;
    this.host.output.appendLine(
      `Wip edit under ${hit.branch} (${path.basename(uri.fsPath)}) — rebuild scheduled`,
    );
    if (this.wipDebounce) clearTimeout(this.wipDebounce);
    this.wipDebounce = setTimeout(() => {
      this.wipDebounce = undefined;
      if (this.rebuildInFlight) {
        // Edits landed mid-rebuild — go again once it finishes
        this.scheduleWipRebuildRetry();
        return;
      }
      void this.runRebuild('wip edits');
    }, 1200);
  }

  private scheduleWipRebuildRetry(): void {
    if (this.wipDebounce) return;
    this.wipDebounce = setTimeout(() => {
      this.wipDebounce = undefined;
      if (this.rebuildInFlight) {
        this.scheduleWipRebuildRetry();
        return;
      }
      void this.runRebuild('wip edits (queued)');
    }, 800);
  }

  /** Toggle overlaying a lane's uncommitted edits; rebuild when applied. */
  async setLaneWip(branch: string, enabled: boolean): Promise<RebuildResult> {
    if (!this.previewPath)
      return { ok: false, code: 'error', message: 'preview mode is off' };
    await setWipLane(this.previewPath, branch, enabled);
    await this.refreshState();
    this.host.fireTreeData();
    if (this.lanes.includes(branch))
      return this.runRebuild(enabled ? `wip on ${branch}` : `wip off ${branch}`);
    return { ok: true, lanes: this.lanes.slice(), skipped: [], landed: [], resolved: [] };
  }

  /**
   * Auto-rebuild: rebuild the preview tree when the base or an applied
   * lane tip moves (commit/amend/rebase anywhere — no git hook needed).
   */
  async tick(): Promise<void> {
    if (!this.previewPath || this.rebuildInFlight) return;
    if (!isPreviewAutoRebuildEnabled()) {
      this.fingerprint = undefined;
      return;
    }
    // Track where PRs actually land: refresh origin/<base> periodically.
    // A moved tip changes the fingerprint below and triggers the rebuild.
    const fetchMs = vscode.workspace
      .getConfiguration('worktreeCompare')
      .get<number>('previewFetchIntervalMs', 300000);
    if (fetchMs > 0 && Date.now() - this.lastBaseFetchAt > fetchMs) {
      this.lastBaseFetchAt = Date.now();
      // Fire-and-forget: never let a slow/hung remote stall the tick. A
      // moved tip is picked up by the fingerprint on the next tick.
      void fetchPreviewBase(this.previewPath, previewBaseRef())
        .then((ok) =>
          this.host.output.appendLine(
            ok
              ? `Fetched origin ${previewBaseRef()} (preview base)`
              : 'Preview base fetch failed (offline / no remote?)',
          ),
        )
        .catch(() => {});
    }
    // Conflicts no longer dirty the checkout (off-tree merge), so keep
    // retrying — a new commit on the conflicting lane may resolve it.
    let fp: string;
    try {
      fp = await previewFingerprint(
        this.previewPath,
        previewBaseRef(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`Preview fingerprint failed: ${message}`);
      return;
    }
    if (this.fingerprint === undefined) {
      this.fingerprint = fp;
      return;
    }
    if (fp === this.fingerprint) return;
    this.fingerprint = fp;
    await this.runRebuild('lane tips moved');
  }

  /**
   * Keep the pre-commit guard in step with preview state. Installed
   * while preview is on, removed when it goes off, and re-pointed when
   * the branch is renamed — reconciled from refreshState rather than from
   * the enable/disable commands so it also covers checkouts made by hand
   * and repos that had preview on before the guard existed.
   *
   * Failure is logged, never surfaced: a repo where hooks cannot be written
   * (read-only .git, an unusual hooksPath) still works exactly as it did
   * before — it just does not get the extra warning.
   */
  private async syncCommitGuard(
    workingPath: string | undefined,
    branch: string,
  ): Promise<void> {
    const cwd = workingPath ?? this.host.getRepoCwd();
    if (!cwd) return;
    try {
      if (!workingPath) {
        await uninstallCommitGuard(cwd);
        await uninstallLaneCli(cwd);
        // A recorded conflict outlasting the preview it described is worse
        // than no record: it reads as a live failure in a repo that has no
        // preview to fail. The settings go for the same reason — a CLI
        // run later must refuse rather than rebuild a preview that was
        // turned off.
        await clearPreviewStatus(cwd);
        await clearPreviewSettings(cwd);
        await clearRunnerCommand(await commonDir(cwd));
        return;
      }
      // The lane CLI is how anything outside VS Code joins the preview, so
      // it tracks preview being ON — not the guard's setting.
      if (await installLaneCli(cwd)) {
        this.host.output.appendLine(
          `Lane CLI installed: ${await laneCliPath(cwd)}`,
        );
      }
      // The settings a headless run needs (and its vscode shim serves),
      // plus how to run it. Both are rewritten here rather than at enable
      // time so they follow a renamed branch, a changed base, and an
      // extension that moved on disk after an update.
      await writePreviewSettings(cwd, {
        branch,
        base: previewBaseRef(),
        checkout: workingPath,
        autoResolve: vscode.workspace
          .getConfiguration('worktreeCompare')
          .get<string>('previewAutoResolve'),
      });
      await this.recordRunnerCommand(cwd);
      if (!isCommitGuardEnabled()) {
        await uninstallCommitGuard(cwd);
        return;
      }
      const result = await installCommitGuard(cwd, branch);
      if (result === 'foreign') {
        this.host.output.appendLine(
          `Commit guard not installed: ${cwd} has a pre-commit hook that is not a shell script — chaining into it could break every commit, so it was left alone`,
        );
      } else if (result !== 'unchanged') {
        this.host.output.appendLine(
          result === 'chained'
            ? `Commit guard chained into the existing pre-commit hook: refusing commits on ${branch}`
            : `Commit guard ${result}: refusing commits on ${branch}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`Commit guard sync failed: ${message}`);
    }
  }

  /**
   * Base changed: the templated branch name may change with it — rename
   * the checkout's branch to match, then rebuild onto the new base.
   */
  async handleBaseChange(): Promise<void> {
    if (!this.previewPath) {
      this.host.fireTreeData();
      return;
    }
    // The pin belongs to the OLD base — drop it so refreshState re-pins
    // fresh on the new one.
    await clearBasePin(this.previewPath).catch(() => {});
    try {
      const renamed = await alignPreviewBranchName(this.previewPath);
      if (renamed) {
        this.host.output.appendLine(
          `Preview branch renamed: ${renamed.from} → ${renamed.to}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`Preview branch rename failed: ${message}`);
    }
    await this.runRebuild('base changed');
    this.host.refresh();
  }

  /**
   * Record how a shell runs a preview operation in this repo.
   *
   * The editor is not a server and nothing connects to it: `gw-lane` runs
   * the bundled one-shot CLI itself, taking the same lock this process
   * takes. All it needs is where to find it — which a shell cannot know,
   * least of all after an update moves the extension. So the recipe is
   * written beside the state it operates on, naming the editor's own node
   * (`process.execPath` under ELECTRON_RUN_AS_NODE, frequently the only
   * node on the machine) and the bundle shipped alongside. Rewritten on
   * every reconcile, so a moved install heals itself.
   */
  private async recordRunnerCommand(cwd: string): Promise<void> {
    const root = this.host.extensionPath?.();
    if (!root) return;
    try {
      await writeRunnerCommand(await commonDir(cwd), {
        node: process.execPath,
        script: path.join(root, 'dist', 'gw-op.js'),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.output.appendLine(`Runner command not recorded: ${message}`);
    }
  }

  /**
   * Rebuild, in this process.
   *
   * The same operation `gw-lane rebuild` runs, differing only in where the
   * settings come from: the editor's are live, so it passes them rather
   * than reading back the file it just wrote. Exclusion between the two is
   * the rebuild lock, which both take and which now records its holder —
   * that, not a queue, is what makes concurrent writers safe.
   */
  private async rebuildVia(
    workingPath: string,
    _reason: string,
  ): Promise<RebuildResult> {
    const outcome = await rebuildFromSettings(workingPath, {
      branch: previewBranch(),
      base: previewBaseRef(),
      checkout: workingPath,
    });
    return outcome.kind === 'ran'
      ? outcome.result
      : { ok: false, code: 'error', message: outcome.message };
  }

  /**
   * A membership change — one implementation (preview/laneOp), shared with
   * the CLI. The controller no longer composes lane-file helpers by hand,
   * which is how its verbs drifted from the script's in the first place.
   */
  private async laneOp(op: LaneOpName, lane: string): Promise<void> {
    const cwd = this.previewPath;
    if (!cwd) return;
    const result = await runLaneOp(cwd, op, lane);
    if (!result.ok) {
      this.host.output.appendLine(`Lane ${op} refused: ${result.message}`);
    }
  }

  /** Run a rebuild and surface the outcome on the preview row. */
  async runRebuild(reason: string): Promise<RebuildResult> {
    const workingPath = this.previewPath;
    if (!workingPath)
      return { ok: false, code: 'error', message: 'preview mode is off' };
    if (this.rebuildInFlight) {
      // Never drop intent (e.g. unchecking a lane mid-rebuild): queue one
      // follow-up run — it re-reads the lane files, so it applies whatever
      // state the caller just wrote. Reasons ACCUMULATE: overwriting lost
      // a queued manual's fetch when hide/apply queued after it, leaving
      // landed/badge state on a stale origin (CI-only timing).
      this.rebuildQueued = this.rebuildQueued
        ? `${this.rebuildQueued} + ${reason}`
        : reason;
      return { ok: false, code: 'busy', message: 'rebuild already running' };
    }
    this.rebuildInFlight = true;
    const t0 = Date.now();
    try {
      if (reason.includes('manual')) {
        // Manual rebuild = "give me reality": refresh the base tip first.
        // includes(): the manual marker must survive queueing — both the
        // '(queued)' suffix and accumulation with other queued reasons.
        this.lastBaseFetchAt = Date.now();
        await fetchPreviewBase(workingPath, previewBaseRef());
      }
      const result = await this.rebuildVia(workingPath, reason);
      if (result.ok) {
        this.error = undefined;
        this.autoResolved = result.resolved;
        for (const r of result.resolved) {
          this.host.output.appendLine(
            `Lane ${r.lane} auto-resolved${
              r.lossless.length > 0
                ? ` · lossless: ${r.lossless.join(', ')}`
                : ''
            }${
              r.lossy.length > 0
                ? ` · lane-wins (hunks dropped): ${r.lossy.join(', ')}`
                : ''
            }`,
          );
        }
        // Landed lanes were retired by the rebuild itself (under its lock);
        // rows stay as candidates with the 'landed' tag
        for (const lane of result.landed) {
          this.host.output.appendLine(
            `Lane ${lane} landed in ${previewBaseRef()} — unapplied`,
          );
        }
        this.host.output.appendLine(
          `Preview rebuilt (${reason}): ${
            result.lanes.length > 0 ? result.lanes.join(', ') : 'base only'
          }${
            result.skipped.length > 0
              ? ` · skipped missing: ${result.skipped.join(', ')}`
              : ''
          } (${Date.now() - t0}ms)`,
        );
      } else if (result.code === 'busy') {
        // Script/hook holds the lock — not an error state for the row
        this.host.output.appendLine(`Preview rebuild busy (${reason})`);
      } else if (result.code === 'unique' && isPreviewAbsorbEnabled()) {
        // Work committed directly on the preview checkout. The rebuild
        // refuses rather than destroy it, which protects the commits but
        // deadlocks the preview — absorbing is the exit. On success the
        // work lands on the base as ordinary drift and the queued rebuild
        // (below) picks up where this one stopped.
        const absorbed = await this.absorbStrays();
        if (absorbed?.ok) {
          this.error = undefined;
          this.rebuildQueued = this.rebuildQueued
            ? `${this.rebuildQueued} + absorbed strays`
            : 'absorbed strays';
        } else {
          this.error = { code: result.code, message: result.message };
          this.host.output.appendLine(
            `Preview rebuild failed (${reason}, ${result.code}): ${result.message}`,
          );
        }
      } else {
        this.error = {
          code: result.code,
          message: result.message,
          lane: result.lane,
        };
        this.host.output.appendLine(
          `Preview rebuild failed (${reason}, ${result.code}${
            result.lane ? `, lane ${result.lane}` : ''
          }): ${result.message}`,
        );
      }
      await this.refreshState();
      this.host.refreshCompare(workingPath);
      this.host.fireTreeData();
      return result;
    } finally {
      this.rebuildInFlight = false;
      if (this.rebuildQueued) {
        const queued = this.rebuildQueued;
        this.rebuildQueued = undefined;
        void this.runRebuild(`${queued} (queued)`);
      }
    }
  }

  /** Offer a branch under the Preview row (unchecked; no rebuild). */
  async addCandidate(branch: string): Promise<void> {
    if (!this.previewPath) return;
    if (!isLaneBranch(branch, previewBaseRef()))
      throw new Error(`${branch} cannot be an preview lane`);
    // Re-adding is also how an excluded auto member comes back
    await this.laneOp('candidate', branch);
    await this.refreshState();
    this.host.fireTreeData();
  }

  /**
   * Drop a branch from the Preview row; rebuild if it was applied.
   * Also records an exclusion — auto members (base matches) would just
   * reappear on the next refresh otherwise, and Remove must be a real
   * exit for every row. Add to Preview clears the exclusion.
   */
  async removeCandidate(branch: string): Promise<RebuildResult> {
    if (!this.previewPath)
      return { ok: false, code: 'error', message: 'preview mode is off' };
    // One op: out of the tree, off the list, and kept out. It was three
    // helper calls split across two methods, which is why the shell's
    // `remove` and this one had to be compared line by line to see they
    // agreed.
    const wasApplied = this.lanes.includes(branch);
    await this.laneOp('remove', branch);
    if (wasApplied) return this.runRebuild(`remove ${branch}`);
    await this.refreshState();
    this.host.fireTreeData();
    return { ok: true, lanes: this.lanes.slice(), skipped: [], landed: [], resolved: [] };
  }

  /** Add this branch as a lane and rebuild. */
  async apply(branch: string): Promise<RebuildResult> {
    if (!this.previewPath)
      return { ok: false, code: 'error', message: 'preview mode is off' };
    if (!isLaneBranch(branch, previewBaseRef())) {
      return {
        ok: false,
        code: 'error',
        message: `will not apply ${branch} as a lane`,
      };
    }
    await this.laneOp('apply', branch);
    return this.runRebuild(`apply ${branch}`);
  }

  /** Drop this branch from the lanes and rebuild. */
  async hide(branch: string): Promise<RebuildResult> {
    if (!this.previewPath)
      return { ok: false, code: 'error', message: 'preview mode is off' };
    await this.laneOp('unapply', branch);
    return this.runRebuild(`hide ${branch}`);
  }

  /**
   * Deliberately advance the frozen base to the local <base> tip (the
   * Catch Up exit for base drift) and rebuild onto it.
   */
  /**
   * Toggle whether the base's unpushed commits (the drift lane) join the
   * preview. Exclusion persists as the base name in focus-excluded, so
   * "never show main's local noise" survives future commits.
   */
  async setBaseDriftIncluded(included: boolean): Promise<RebuildResult> {
    if (!this.previewPath)
      return { ok: false, code: 'error', message: 'preview mode is off' };
    // NOT a lane op: this is the synthetic base-drift segment, which has
    // no branch to apply and lives only in the exclusion list. Routing it
    // through runLaneOp would make it a candidate row of its own.
    const baseName = previewBaseRef().replace(/^origin\//, '');
    if (included) {
      await dropExcludedLane(this.previewPath, baseName);
    } else {
      await addExcludedLane(this.previewPath, baseName);
    }
    await this.refreshState();
    this.host.fireTreeData();
    return this.runRebuild(
      included ? `include ${baseName} drift` : `exclude ${baseName} drift`,
    );
  }

  /**
   * The checkout that absorbed work goes to: the base branch's own
   * worktree. Landing it there makes it ordinary base drift, which is
   * already a first-class lane with Catch Up and Move-to-Branch exits —
   * so the rescue needs no escape hatches of its own.
   */
  private async absorbTarget(): Promise<AbsorbTarget | undefined> {
    if (!this.previewPath) return undefined;
    const baseName = previewBaseRef().replace(/^origin\//, '');
    if (!(await gitOk(this.previewPath, [
      'rev-parse',
      '-q',
      '--verify',
      `refs/heads/${baseName}`,
    ]))) {
      return undefined; // no base branch at all — nothing to absorb into
    }
    const path = await checkoutForBranch(this.previewPath, baseName);
    // Prefer a checkout so the replay leaves its working tree consistent;
    // fall back to the ref, which is the ONLY option when preview was
    // enabled by switching a checkout in place — the base then has no
    // worktree of its own.
    return path
      ? { kind: 'checkout', path, branch: baseName }
      : { kind: 'ref', branch: baseName };
  }

  /**
   * Move commits made directly on the preview branch onto the base.
   * Runs unattended: a commit is an explicit act marking a unit of work
   * complete, so nothing is taken out from under anyone. Uncommitted edits
   * are deliberately NOT absorbed automatically — an agent may still be
   * mid-write, and yanking files it is about to read back is worse than
   * the deadlock.
   */
  async absorbStrays(
    options: { confirmed?: boolean } = {},
  ): Promise<AbsorbResult | undefined> {
    const workingPath = this.previewPath;
    if (!workingPath) return undefined;
    // One attempt per preview tip: a target that keeps refusing (dirty,
    // or a conflict needing a human) must not re-arm the rebuild queue on
    // every tick.
    const head = await revParseCommit(workingPath, 'HEAD');
    if (!options.confirmed && head && head === this.lastAbsorbHead)
      return undefined;
    this.lastAbsorbHead = head;
    const target = await this.absorbTarget();
    if (!target) {
      this.host.output.appendLine(
        'Preview strays: the base branch does not exist — cannot absorb',
      );
      return {
        ok: false,
        code: 'no-target',
        message: 'the base branch does not exist locally',
      };
    }
    // Added files are the one shape a replay cannot vet (see
    // addedPathsInCommits). They only carry that risk while lanes are
    // merged in — with a base-only chain the preview tree IS the base,
    // so there is no lane context for anything to depend on. In that case
    // ask instead of moving work unattended.
    if (!options.confirmed && this.lanes.length > 0) {
      const baseSha = await resolveBaseSha(workingPath, previewBaseRef());
      const strays = baseSha
        ? await findStrayCommits(workingPath, baseSha, previewBranch())
        : [];
      const added = await addedPathsInCommits(
        workingPath,
        strays.map((c) => c.sha),
      );
      if (added.length > 0) {
        this.host.output.appendLine(
          `Preview strays add ${added.join(', ')} — not absorbed automatically (lanes applied)`,
        );
        void vscode.window
          .showWarningMessage(
            `Git Workflow: the preview checkout has commits adding ${added.join(', ')}. Merged lanes are in this tree, so those files may depend on code the base does not have — absorbing is not automatic here.`,
            'Absorb Anyway',
            'Move to a Branch…',
          )
          .then((choice) => {
            if (choice === 'Absorb Anyway') {
              void vscode.commands.executeCommand(
                'worktreeCompare.absorbPreviewCommits',
              );
            } else if (choice === 'Move to a Branch…') {
              void vscode.commands.executeCommand(
                'worktreeCompare.branchifyBaseDrift',
              );
            }
          });
        return {
          ok: false,
          code: 'needs-confirmation',
          message: `stray commits add ${added.join(', ')}`,
          files: added,
        };
      }
    }
    const result = await absorbStrayCommits(
      workingPath,
      previewBaseRef(),
      target,
      previewBranch(),
    );
    if (result.ok) {
      const baseName = previewBaseRef().replace(/^origin\//, '');
      this.host.output.appendLine(
        `Absorbed ${result.commits} stray commit(s) from the preview checkout into ${baseName}`,
      );
      void vscode.window
        .showInformationMessage(
          `Git Workflow: moved ${result.commits} commit(s) made on the preview checkout onto ${baseName} — they now show as unpushed base work.`,
          'Move to a Branch…',
        )
        .then((choice) => {
          if (choice) {
            void vscode.commands.executeCommand(
              'worktreeCompare.branchifyBaseDrift',
            );
          }
        });
    } else if (result.code === 'busy') {
      // One attempt per tip is what keeps a genuinely unabsorbable commit
      // from retrying forever — but a held index.lock is not that. Clearing
      // the guard lets the next tick try again, which is all this needs.
      this.lastAbsorbHead = undefined;
      this.host.output.appendLine(
        `Absorbing preview strays deferred: ${result.message}`,
      );
    } else if (result.code !== 'nothing') {
      this.host.output.appendLine(
        `Absorbing preview strays failed (${result.code}): ${result.message}${
          result.files?.length ? ` · ${result.files.join(', ')}` : ''
        }`,
      );
    }
    return result;
  }

  /**
   * Move a lane in the merge order, then rebuild so the preview reflects
   * it. A rebuild holding the lock means the reorder did not happen — the
   * tick that follows it will render the order that actually exists, so
   * there is nothing to reconcile.
   */
  async reorderLane(lane: string, before?: string): Promise<void> {
    if (!this.previewPath) return;
    const moved = await reorderLaneFile(
      this.previewPath,
      lane,
      before,
    ).catch(() => false);
    if (!moved) {
      this.host.fireTreeData();
      return;
    }
    this.host.output.appendLine(
      `Lane ${lane} moved ${before ? `before ${before}` : 'last'}`,
    );
    await this.refreshState();
    await this.runRebuild('lane order changed');
    this.host.fireTreeData();
  }

  /**
   * Retire lanes whose landing the rebuild's cheap check cannot see.
   *
   * A lane that landed and then watched other PRs merge on top conflicts
   * against the base, so the fast predicate reads it as unlanded: it never
   * retires and sits in the preview reporting a conflict forever. The
   * deeper probe finds it, but walks base history, so it runs HERE — once
   * per meaningful change — rather than inside every rebuild.
   *
   * Keyed on the base and the applied set, so a moving base re-sweeps once
   * and a quiet repo never sweeps twice.
   */
  private async sweepStaleLandings(
    workingPath: string,
    baseRef: string,
  ): Promise<void> {
    if (this.lanes.length === 0) return;
    const key = `${await resolveBaseSha(workingPath, baseRef)}\u0000${this.lanes.join(',')}`;
    if (this.staleSweptFor === key) return;
    this.staleSweptFor = key;
    const stale = await findStaleLandedLanes(
      workingPath,
      baseRef,
      this.lanes.filter((l) => !this.landed.includes(l)),
    ).catch(() => [] as string[]);
    if (stale.length === 0) return;
    this.host.output.appendLine(
      `Lanes landed (base moved past them), retiring: ${stale.join(', ')}`,
    );
    for (const lane of stale) {
      // Same door as every other membership change, so retirement cannot
      // mean something subtly different from unchecking
      await this.laneOp('unapply', lane);
    }
    this.landed = [...new Set([...this.landed, ...stale])];
    this.lanes = this.lanes.filter((l) => !stale.includes(l));
    await this.runRebuild('stale landings retired');
  }

  /** Absorb stray commits the user explicitly approved, then rebuild. */
  async absorbStraysConfirmed(): Promise<AbsorbResult | undefined> {
    const result = await this.absorbStrays({ confirmed: true });
    if (result?.ok) {
      await this.runRebuild('absorbed strays (confirmed)');
      this.host.refresh();
    }
    return result;
  }

  /**
   * Move UNCOMMITTED preview edits onto the base. Only ever runs from
   * an explicit command — see absorbStrays for why this is never automatic.
   */
  async absorbEdits(): Promise<AbsorbResult> {
    const workingPath = this.previewPath;
    if (!workingPath)
      return { ok: false, code: 'error', message: 'preview mode is off' };
    const target = await this.absorbTarget();
    // Uncommitted work has to land in a working tree, so unlike stray
    // COMMITS this one cannot fall back to the ref. Committing it on the
    // user's behalf would be deciding the work is finished.
    if (target?.kind !== 'checkout') {
      return {
        ok: false,
        code: 'no-target',
        message: target
          ? `${target.branch} has no worktree — check it out somewhere, or commit these edits and let them absorb`
          : 'the base branch does not exist locally',
      };
    }
    const result = await absorbDirtyEdits(
      workingPath,
      target.path,
      previewBranch(),
    );
    if (result.ok) {
      this.host.output.appendLine(
        `Absorbed uncommitted preview edits into ${target.path}`,
      );
      // The checkout is clean again — the dirty guard no longer blocks
      await this.runRebuild('absorbed edits');
    } else {
      this.host.output.appendLine(
        `Absorbing preview edits failed (${result.code}): ${result.message}`,
      );
    }
    return result;
  }

  async catchUpBase(): Promise<RebuildResult> {
    if (!this.previewPath || !this.baseDrift)
      return { ok: false, code: 'error', message: 'no base drift to catch up' };
    await writeBasePin(this.previewPath, this.baseDrift.sha);
    this.host.output.appendLine(
      `Preview base caught up to ${this.baseDrift.sha.slice(0, 10)}`,
    );
    const result = await this.runRebuild('base caught up');
    this.host.refresh();
    return result;
  }

  /** Abort a conflicted lane merge, leaving the tree at the last good state. */
  async abortMerge(): Promise<void> {
    if (!this.previewPath) return;
    await abortPreviewMerge(this.previewPath);
    this.error = undefined;
    this.fingerprint = undefined;
    this.host.refreshCompare(this.previewPath);
    this.host.fireTreeData();
  }

  dispose(): void {
    if (this.wipDebounce) {
      clearTimeout(this.wipDebounce);
      this.wipDebounce = undefined;
    }
  }
}
