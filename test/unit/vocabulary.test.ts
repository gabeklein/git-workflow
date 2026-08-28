import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The preview has one name in its public surface.
 *
 * "Integration" was renamed to "Preview" with no aliases kept, and a
 * half-finished rename is the failure mode that outlives the decision: a
 * command id or setting key still saying "integration" keeps the old word
 * alive in keybindings, settings.json and every doc that quotes them,
 * long after the UI stopped using it.
 *
 * IDENTIFIERS only. Prose is free to say "integration" — the GitHub sense
 * of the word is a different feature and keeps its name.
 */
describe('one name for the preview', () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', '..', 'package.json'),
      'utf8',
    ),
  ) as {
    contributes: {
      commands: { command: string }[];
      configuration: { properties: Record<string, { default?: unknown }> };
      menus: Record<string, { command?: string; when?: string }[]>;
      views: Record<string, { id: string }[]>;
    };
  };
  const { contributes } = manifest;

  const identifiers = (): string[] => [
    ...contributes.commands.map((c) => c.command),
    ...Object.keys(contributes.configuration.properties),
    ...Object.values(contributes.views)
      .flat()
      .map((v) => v.id),
    ...Object.values(contributes.menus)
      .flat()
      .flatMap((m) => [m.command ?? '', m.when ?? '']),
  ];

  it('has no command id, setting key, view id or when-clause saying integration', () => {
    // Guard against a vacuous pass: an empty list would satisfy the
    // assertion below while proving nothing.
    expect(identifiers().length).toBeGreaterThan(50);
    const stragglers = identifiers().filter((id) => /integration/i.test(id));
    expect(stragglers).toEqual([]);
  });

  it('defaults the branch template to preview/{base}', () => {
    expect(
      contributes.configuration.properties['worktreeCompare.previewBranch']
        ?.default,
    ).toBe('preview/{base}');
  });
});
