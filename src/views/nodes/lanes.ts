import * as vscode from 'vscode';

/**
 * The base's unpushed commits, shown as a LANE: the frozen base defines
 * the floor, and everything unlanded — main's own local work included —
 * is a checkable lane. Checked by default (unpushed base work is almost
 * always meant to be seen); unchecking persists. Pushing lands it and the
 * row disappears.
 */
export class BaseDriftItem extends vscode.TreeItem {
  readonly kind = 'previewBaseDrift' as const;

  constructor(
    readonly baseName: string,
    readonly drift: {
      ahead: number;
      sha: string;
      resetTo: string;
      included: boolean;
    },
  ) {
    super(baseName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'previewBaseDrift';
    this.description = `+${drift.ahead} unpushed`;
    this.checkboxState = {
      state: drift.included
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: drift.included
        ? `${baseName}'s unpushed commits are merged into the preview — uncheck to leave them out (persists)`
        : `Merge ${baseName}'s unpushed commits into the preview`,
    };
    this.iconPath = new vscode.ThemeIcon(
      'repo',
      drift.included ? new vscode.ThemeColor('charts.yellow') : undefined,
    );
    this.tooltip = [
      `${baseName} has ${drift.ahead} unpushed commit(s). The preview base stays frozen — unpushed base work is unlanded work, so it rides along as a lane instead of silently becoming the floor.`,
      '',
      drift.included
        ? 'Included in the preview. Uncheck to leave it out (the choice persists across future commits).'
        : 'Excluded from the preview. Check to merge it in.',
      'Pushing the base lands it — the frozen base advances and this row disappears.',
      'Context menu: Move New Base Commits to a Branch… (make it real feature work) · Catch Up Preview Base (make it the floor on purpose).',
    ].join('\n');
  }
}

/**
 * One candidate lane under the Preview row. Checked = the branch is
 * merged into the preview tree; unchecked = candidate only.
 */
export class PreviewLaneItem extends vscode.TreeItem {
  readonly kind = 'previewLane' as const;

  constructor(
    readonly branch: string,
    readonly applied: boolean,
    opts?: {
      /** This lane failed the last rebuild (merge conflict) */
      conflicted?: boolean;
      /** Worktree checkout of this branch, for click-to-focus */
      worktreePath?: string;
      /** Lane branch no longer exists */
      missing?: boolean;
      /** Uncommitted edits from the checkout overlay into rebuilds */
      wip?: boolean;
      /** Lane tip is contained in the base — it landed */
      landed?: boolean;
      /** A base merge is paused in the lane's worktree */
      resolving?: boolean;
      /** Auto member (its base matches the preview base), or a lane
       *  applied outside the extension — not an explicit add. */
      auto?: boolean;
      /** The last rebuild resolved this lane's clashes instead of failing. */
      autoResolved?: { lossless: string[]; lossy: string[] };
    },
  ) {
    super(branch, vscode.TreeItemCollapsibleState.None);
    // Wip toggle only offered for lanes that have a checkout
    const wipFlag = opts?.worktreePath
      ? opts?.wip
        ? 'WipOn'
        : 'WipOff'
      : '';
    // Resolve Conflict needs a checkout to run the merge in
    const conflictFlag = opts?.resolving
      ? 'Resolving'
      : opts?.conflicted && opts?.worktreePath
        ? 'Conflicted'
        : '';
    this.contextValue = `${applied ? 'previewLaneApplied' : 'previewLane'}${wipFlag}${conflictFlag}`;
    this.checkboxState = {
      state: applied
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: applied
        ? `${branch} is merged into the preview tree — uncheck to remove`
        : `Merge ${branch} into the preview tree`,
    };
    if (opts?.resolving) {
      this.description = 'resolving merge';
      this.iconPath = new vscode.ThemeIcon(
        'git-merge',
        new vscode.ThemeColor('charts.orange'),
      );
    } else if (opts?.conflicted) {
      this.description = opts?.wip ? 'conflict · +wip' : 'conflict';
      this.iconPath = new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('list.errorForeground'),
      );
    } else if (opts?.landed) {
      this.description = 'landed';
      this.iconPath = new vscode.ThemeIcon(
        'pass-filled',
        new vscode.ThemeColor('charts.green'),
      );
    } else if (opts?.autoResolved && opts.autoResolved.lossy.length > 0) {
      // Lossless resolutions stay silent — they are what a human would
      // have done. Dropped hunks are never silent.
      this.description = opts?.wip ? 'auto-resolved · +wip' : 'auto-resolved';
      this.iconPath = new vscode.ThemeIcon(
        'git-merge',
        new vscode.ThemeColor('charts.yellow'),
      );
    } else if (opts?.wip) {
      this.description = '+wip';
      this.iconPath = new vscode.ThemeIcon(
        'edit',
        applied ? new vscode.ThemeColor('charts.yellow') : undefined,
      );
    } else if (opts?.missing) {
      this.description = 'branch missing';
      this.iconPath = new vscode.ThemeIcon(
        'question',
        new vscode.ThemeColor('disabledForeground'),
      );
    } else {
      this.iconPath = new vscode.ThemeIcon('git-branch');
    }
    this.tooltip = [
      branch,
      applied
        ? 'Applied — merged into the preview tree (landed commits only).'
        : 'Candidate — check to merge its landed commits in.',
      opts?.resolving
        ? 'A base merge is paused in the lane worktree — resolve the markers, then Complete Merge from Base.'
        : opts?.conflicted
          ? 'This lane conflicts with the base; the checkout was left untouched. Resolve Conflict with Base starts the fix in the lane worktree.'
          : undefined,
      opts?.wip
        ? 'Working-tree edits included: uncommitted changes from the checkout overlay into rebuilds (saves in VS Code re-trigger).'
        : undefined,
      opts?.landed
        ? 'Landed — merging this lane into the base changes nothing. Safe to remove this row and delete the branch/worktree.'
        : undefined,
      opts?.missing ? 'The branch no longer exists.' : undefined,
      opts?.autoResolved && opts.autoResolved.lossy.length > 0
        ? `Auto-resolved lane-wins (clashing hunks from the other side were dropped): ${opts.autoResolved.lossy.join(', ')}. Catch the lane up with its base to make this exact.`
        : undefined,
      opts?.autoResolved &&
      opts.autoResolved.lossy.length === 0 &&
      opts.autoResolved.lossless.length > 0
        ? `Clashes auto-resolved losslessly (both sides kept): ${opts.autoResolved.lossless.join(', ')}.`
        : undefined,
      opts?.auto
        ? 'Auto member — its base matches the preview base. Remove from Preview hides it until it is added back.'
        : undefined,
    ]
      .filter((x): x is string => Boolean(x))
      .join('\n');
    if (opts?.worktreePath) {
      this.command = {
        command: 'worktreeCompare.focusWorktree',
        title: 'Focus Worktree',
        arguments: [opts.worktreePath],
      };
    }
  }
}

/**
 * The preview, as the leading row of Lanes.
 *
 * It used to be a whole panel, which made it look like a peer of "your
 * branches" when it is really one derived branch built from some of them.
 * As a row it sits in the same tree as its lanes, directly above them.
 *
 * Its children are the lanes; everything the panel's title menu used to
 * carry (Rebuild, Change Base, Disable, Absorb) moves to this row's
 * context menu.
 */
export class PreviewItem extends vscode.TreeItem {
  readonly kind = 'preview' as const;

  constructor(
    readonly branch: string,
    readonly baseRef: string,
    opts: {
      laneCount: number;
      wip: boolean;
      error?: { code?: string; message: string };
      mergePaused?: boolean;
    },
  ) {
    super(branch, vscode.TreeItemCollapsibleState.Expanded);
    const flags = [
      opts.error?.code === 'dirty' ? 'Dirty' : '',
      opts.mergePaused ? 'MergePaused' : '',
    ].join('');
    this.contextValue = `preview${flags}`;
    const bits = [`→ ${baseRef.replace(/^origin\//, '')}`];
    bits.push(
      opts.laneCount === 1 ? '1 lane' : `${opts.laneCount} lanes`,
    );
    if (opts.wip) bits.push('+wip');
    // The failure states earn their place ahead of nothing else — a preview
    // that did not build is the only thing about it worth reading.
    if (opts.error?.code === 'conflict') {
      bits.push('lane conflict');
    } else if (opts.error) {
      bits.push('rebuild failed');
    }
    this.description = bits.join(' · ');
    this.iconPath = new vscode.ThemeIcon(
      'beaker',
      opts.error
        ? new vscode.ThemeColor('charts.red')
        : new vscode.ThemeColor('charts.purple'),
    );
    this.tooltip = [
      `${branch} — a preview of ${baseRef} with its applied lanes merged in`,
      opts.error?.message,
      'Derived state: every rebuild recreates it, so nothing should be committed here.',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
