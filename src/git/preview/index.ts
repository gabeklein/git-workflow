/**
 * What the rest of the extension may use from the preview subsystem.
 *
 * Ten modules live behind this: the config it reads, the lane files it
 * keeps, the off-tree merge, the rebuild engine, the branch lifecycle,
 * absorb, the commit guard and the shell CLI. Views and commands want
 * about fifty things out of that, and an `export *` per module made the
 * other surface — every helper the engine and the merge use on each other
 * — look equally public, so nothing could be moved or renamed without
 * checking the whole tree.
 *
 * Listing them is the point: what is here is the contract, and what is not
 * is internal. Tests reach past this file on purpose, straight at the
 * module under test.
 */

// config
export {
  autoRebaseLanes,
  catchUpStrategy,
  previewBaseRef,
  previewBranch,
  expendableIgnoredPatterns,
  isAutoRemoveLandedEnabled,
  isCommitGuardEnabled,
  isPruneRemoteRefsEnabled,
  isPreviewAbsorbEnabled,
  isPreviewAutoRebuildEnabled,
  isLaneBranch,
  isQuickDeleteLandedEnabled,
} from './config';

// lanes
export {
  addAppliedLane,
  addCandidateLane,
  addExcludedLane,
  clearBasePin,
  dropAppliedLane,
  dropCandidateLane,
  dropExcludedLane,
  ensurePreviewPushBlocked,
  listAppliedLanes,
  listCandidateLanes,
  listExcludedLanes,
  listWipLanes,
  pruneDeadLanes,
  readBasePin,
  reorderLane,
  setWipLane,
  writeBasePin,
} from './lanes';

// status
export {
  baseStatusFor,
  fetchPreviewBase,
  findLandedLanes,
  findStaleLandedLanes,
  findStrayCommits,
  previewFingerprint,
  laneNeverDiverged,
  resolveBaseSha,
} from './status';

// engine
export {
  type RebuildResult,
  type ResolvedLane,
  abortPreviewMerge,
  rebuildPreview,
} from './engine';

// lifecycle
export {
  alignPreviewBranchName,
  deletePreviewBranch,
  switchAwayFromPreview,
  switchToPreviewBranch,
} from './lifecycle';

// absorb
export {
  type AbsorbResult,
  type AbsorbTarget,
  absorbDirtyEdits,
  absorbStrayCommits,
  addedPathsInCommits,
  checkoutForBranch,
} from './absorb';

// commitGuard
export {
  installCommitGuard,
  uninstallCommitGuard,
} from './commitGuard';

// laneCli
export {
  installLaneCli,
  laneCliPath,
  uninstallLaneCli,
} from './laneCli';

