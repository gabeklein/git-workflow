import { describe, expect, it } from 'vitest';
import { branchNameFromItem } from '../../src/commands/branchName';

describe('branchNameFromItem', () => {
  it('prefers the branch field', () => {
    expect(
      branchNameFromItem({ branch: 'feat/a', label: 'feat/a (detached)' }),
    ).toBe('feat/a');
  });

  it('trims whitespace on the branch field', () => {
    expect(branchNameFromItem({ branch: '  feat/a  ' })).toBe('feat/a');
  });

  it('falls back to a string label, stripping the detached suffix', () => {
    expect(branchNameFromItem({ label: 'feat/a (detached)' })).toBe('feat/a');
    expect(branchNameFromItem({ label: 'main' })).toBe('main');
  });

  it('refuses empty, missing, and non-string labels', () => {
    expect(branchNameFromItem(undefined)).toBeUndefined();
    expect(branchNameFromItem({})).toBeUndefined();
    expect(branchNameFromItem({ branch: '  ' })).toBeUndefined();
    expect(branchNameFromItem({ label: '   ' })).toBeUndefined();
    expect(branchNameFromItem({ label: { toString: () => 'feat/a' } })).toBeUndefined();
  });
});
