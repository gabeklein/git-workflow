const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Two bundles, one source tree.
 *
 * The extension imports `vscode` from the host; the one-shot CLI has no
 * host, so its bundle substitutes a shim that serves the settings the
 * editor wrote (see src/cli/vscodeShim.ts). Aliasing rather than forking is
 * what keeps a headless rebuild and a sidebar rebuild running the same
 * engine — two copies of the merge rules would drift, and the drift would
 * show up as a preview that differs by who built it.
 */
const shared = {
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  logLevel: 'info',
};

async function main() {
  const cli = await esbuild.context({
    ...shared,
    entryPoints: ['src/cli/main.ts'],
    outfile: 'dist/gw-op.js',
    alias: { vscode: './src/cli/vscodeShim.ts' },
  });

  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
    await cli.watch();
    console.log('[watch] build started');
  } else {
    await ctx.rebuild();
    await cli.rebuild();
    await ctx.dispose();
    await cli.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
