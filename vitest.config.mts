import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // src/git/** touches vscode only via workspace.getConfiguration()
      vscode: path.resolve(import.meta.dirname, 'test/unit/vscode-stub.ts'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    // Scratch repos make real git calls — keep headroom over the default 5s
    testTimeout: 20_000,
  },
});
