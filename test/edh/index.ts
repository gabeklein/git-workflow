/**
 * EDH test entry (extensionTestsPath): runs the compiled *.test.cjs files
 * beside it with mocha. The scenarios are sequential and build on each
 * other — ORDER below is the execution order, and the run bails on the
 * first failure. A test file missing from ORDER is a hard error, so new
 * files must be placed deliberately rather than landing wherever
 * alphabetical order puts them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';
import { getApi } from './helpers';

const ORDER = [
  'overlay.test.cjs', //     activation, enroll/apply, selection, wip overlay
  'files.test.cjs', //       focused-worktree explorer (cleans up after itself)
  'focus.test.cjs', //       unified Focus panel: checkouts, groups, no duplicates
  'landing.test.cjs', //     landed lifecycle, base badges
  'catch-up.test.cjs', //    manual rebase/merge catch-up flows
  'membership.test.cjs', //  auto membership, auto rebase
  'conflicts.test.cjs', //   petty-conflict resolver, dead lane prune
  'base-pin.test.cjs', //    frozen base: drift row, branchify, catch up (mutates main)
  'absorb.test.cjs', //      stray-work rescue out of the integration checkout (mutates main — LAST)
];

export async function run(): Promise<void> {
  const present = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.cjs'));
  const unknown = present.filter((f) => !ORDER.includes(f));
  const missing = ORDER.filter((f) => !present.includes(f));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `test files out of sync with ORDER — unknown: [${unknown.join(', ')}], missing: [${missing.join(', ')}]`,
    );
  }
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    bail: true,
    timeout: 120_000,
    slow: 5_000,
  });
  for (const file of ORDER) {
    mocha.addFile(path.join(__dirname, file));
  }
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures === 0) {
        resolve();
        return;
      }
      // Surface the extension's own log so CI failures are diagnosable
      void getApi()
        .then((api) => {
          const tail = fs
            .readFileSync(api.logFile(), 'utf8')
            .split('\n')
            .slice(-80)
            .join('\n');
          console.log(`[edh] extension log tail:\n${tail}`);
        })
        .catch(() => {})
        .finally(() => reject(new Error(`${failures} test(s) failed`)));
    });
  });
}
