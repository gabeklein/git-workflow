import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The order the two panels are declared in.
 *
 * It is only a default — VS Code remembers each user's own arrangement —
 * but it is the arrangement everyone who has not dragged anything gets,
 * and it has already regressed once without anyone deciding to change it:
 * #45 removed the Integration panel and re-added Lanes below Focus in the
 * process, so a side effect of deleting a third view silently reordered
 * the other two.
 *
 * Lanes is the selector: you click a row there to choose what Focus shows.
 * Selector above detail, which is also the order the two are used in.
 */
describe('sidebar panel order', () => {
  const views = (
    JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as {
      contributes: { views: Record<string, { id: string }[]> };
    }
  ).contributes.views.worktreeCompare;

  it('declares Lanes above Focus', () => {
    expect(views.map((v) => v.id)).toEqual([
      'worktreeCompare.lanes',
      'worktreeCompare.focused',
    ]);
  });
});
