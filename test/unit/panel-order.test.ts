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
  const contributes = (
    JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as {
      contributes: {
        views: Record<string, { id: string; initialSize?: number }[]>;
        viewsContainers: Record<string, { id: string }[]>;
      };
    }
  ).contributes;
  const views = contributes.views.worktreeCompare;
  const containers = contributes.viewsContainers;

  it('declares Lanes above Focus', () => {
    expect(views.map((v) => v.id)).toEqual([
      'worktreeCompare.lanes',
      'worktreeCompare.focused',
    ]);
  });

  /**
   * `initialSize` behaves like CSS `flex` — a relative weight, height in
   * the sidebar — so 1 and 3 is a quarter to Lanes and three quarters to
   * Focus. Lanes is a list of rows and stops growing; Focus holds the diff
   * and uses everything it is given.
   *
   * VS Code honours it only when the same extension owns both the view and
   * its container, which is why the container assertion is here too: move
   * a view into somebody else's container and the split silently stops
   * applying, with no error anywhere.
   */
  it('gives Focus three quarters of the height on first show', () => {
    expect(views.map((v) => v.initialSize)).toEqual([1, 3]);
    expect(containers.activitybar.map((c) => c.id)).toEqual([
      'worktreeCompare',
    ]);
  });
});
