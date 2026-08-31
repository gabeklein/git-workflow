/**
 * What the rest of the extension may use from the preview subsystem.
 *
 * Eleven modules live behind this: the config it reads, the lane files it
 * keeps, the off-tree merge, the rebuild engine, the record it leaves on
 * disk, the branch lifecycle, absorb, the commit guard and the shell CLI. Views and commands want
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
  commonDir,
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

// absorbOp — "move preview work onto the base", the one the CLI runs too
export {
  type AbsorbOptions,
  type AbsorbOutcome,
  absorbFromSettings,
} from './absorbOp';

// rebuildOp — "rebuild this repo's preview", the one the CLI runs too
export { type RebuildOutcome, rebuildFromSettings } from './rebuildOp';

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
  resolveAbsorbTarget,
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

// settings
export {
  CONFIG_FILE,
  type PreviewSettings,
  clearPreviewSettings,
  parsePreviewSettings,
  readPreviewSettings,
  writePreviewSettings,
} from './settings';

// statusFile
export {
  STATUS_FILE,
  clearPreviewStatus,
  readPreviewStatus,
} from './statusFile';

