/**
 * EDH test entry (extensionTestsPath): collects the compiled *.test.cjs
 * files beside it and runs them with mocha, in filename order — the
 * scenarios are sequential and build on each other, hence the numeric
 * prefixes and bail-on-first-failure.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';
import { getApi } from './helpers';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    bail: true,
    timeout: 120_000,
    slow: 5_000,
  });
  for (const file of fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.cjs'))
    .sort()) {
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
