/**
 * Branch name carried on a Lanes-panel row. Worktree, branch, and
 * integration-lane items all expose `branch`; the label is a fallback
 * for rows that only show "name (detached)".
 */
export function branchNameFromItem(item?: {
  branch?: string;
  label?: unknown;
}): string | undefined {
  if (typeof item?.branch === 'string') {
    const name = item.branch.trim();
    if (name) return name;
  }
  if (typeof item?.label === 'string') {
    const name = item.label.replace(/ \(detached\)$/, '').trim();
    if (name) return name;
  }
  return undefined;
}
