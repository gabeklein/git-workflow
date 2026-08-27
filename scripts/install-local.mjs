#!/usr/bin/env node
/**
 * Build a VSIX and install Git Workflow for daily use on this machine.
 *
 * - Packages production dist + .vsix
 * - `code --install-extension` → ~/.vscode/extensions (local UI)
 * - Mirrors into ~/.vscode-server/extensions + extensions.json (Remote-SSH host)
 *
 * Usage: npm run install:local
 * Env:   SKIP_CODE_CLI=1  — only mirror folders (no `code` CLI)
 *        SKIP_SERVER=1    — skip vscode-server mirror
 */
import { execFileSync, execSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const extId = `${pkg.publisher}.${pkg.name}`;
const extFolderName = `${extId}-${pkg.version}`;
const vsixName = `${pkg.name}-${pkg.version}.vsix`;
// Keep out of dist/ (dist is shipped inside the VSIX) and off the repo root
const artifactsDir = path.join(root, 'artifacts');
const vsixPath = path.join(artifactsDir, vsixName);

function log(msg) {
  console.log(`[install:local] ${msg}`);
}

function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  execSync(cmd, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    ...opts,
  });
}

/**
 * Run the editor CLI and decide whether it ACTUALLY installed anything.
 *
 * `code --install-extension` exits 0 even when it prints
 * "Failed Installing Extensions" — a pending uninstall it wants a restart
 * for is the common case. So exit status is not evidence, and the output
 * has to be read. Everything downstream used to treat the CLI as
 * successful and skip unpacking the fresh VSIX, mirroring whatever old
 * directory happened to be sitting there.
 */
function tryEditorInstall(cmd) {
  log(`$ ${cmd}`);
  let out = '';
  let status = 0;
  try {
    out = execSync(`${cmd} 2>&1`, { cwd: root, env: process.env }).toString();
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    status = err.status ?? 1;
  }
  process.stdout.write(out);
  const failed =
    status !== 0 ||
    /Failed Installing Extensions|^Error:/m.test(out);
  return !failed;
}

function which(bin) {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

// 1) Production build
run('npm run package');
mkdirSync(artifactsDir, { recursive: true });

// 2) VSIX into artifacts/ (not dist — dist is included in the package)
run(
  `npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license -o "${vsixPath}"`,
);
// Drop legacy locations from earlier packaging attempts
for (const legacy of [
  path.join(root, vsixName),
  path.join(root, 'dist', vsixName),
]) {
  if (existsSync(legacy)) {
    rmSync(legacy, { force: true });
    log(`Removed legacy ${legacy}`);
  }
}

if (!existsSync(vsixPath)) {
  console.error(`[install:local] expected VSIX missing: ${vsixPath}`);
  process.exit(1);
}
log(`VSIX: ${vsixPath}`);

// 3) Install via Code / Cursor CLI when available
const editorBin =
  process.env.VSCODE_CLI ||
  which('code') ||
  which('cursor') ||
  which('code-insiders');
let cliInstalled = false;
if (!process.env.SKIP_CODE_CLI && editorBin) {
  cliInstalled = tryEditorInstall(
    `"${editorBin}" --install-extension "${vsixPath}" --force`,
  );
  if (!cliInstalled) {
    log(
      'editor CLI did not install (it exits 0 even when it fails) — unpacking the VSIX instead',
    );
  }
} else if (!editorBin) {
  log(
    'No code/cursor CLI found — skipping CLI install (will still mirror folders)',
  );
} else {
  log('SKIP_CODE_CLI set — skipping editor --install-extension');
}

// Source tree after CLI install (preferred) or unpack from VSIX zip
const localExtRoot = path.join(homedir(), '.vscode', 'extensions');
const localExtDir = path.join(localExtRoot, extFolderName);

// ALWAYS unpack. Nothing else here is trustworthy:
//
//   - `code --install-extension` exits 0 even when it prints
//     "Failed Installing Extensions";
//   - and on Remote-SSH it installs to the SERVER, leaving
//     ~/.vscode/extensions untouched — so even a genuine success does not
//     mean this directory was refreshed.
//
// An existing directory therefore proves nothing about its age, and it was
// the mirror source. That is how a build from a fortnight earlier kept
// getting installed while the script cheerfully reported success. The VSIX
// we just built is the only thing here that is known to be current.
{
  log(`Unpacking VSIX into ${localExtDir}`);
  mkdirSync(localExtRoot, { recursive: true });
  const tmp = path.join(root, '.vsix-unpack-tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // VSIX is a zip
  run(`unzip -qo "${vsixPath}" -d "${tmp}"`);
  rmSync(localExtDir, { recursive: true, force: true });
  cpSync(path.join(tmp, 'extension'), localExtDir, { recursive: true });
  // vsixmanifest lives next to extension/ in the archive
  const manifest = path.join(tmp, 'extension.vsixmanifest');
  if (existsSync(manifest)) {
    copyFileSync(manifest, path.join(localExtDir, '.vsixmanifest'));
  }
  rmSync(tmp, { recursive: true, force: true });
  upsertExtensionsJson(path.join(localExtRoot, 'extensions.json'), localExtDir);
}

// 4) Mirror to Remote-SSH server extensions
if (!process.env.SKIP_SERVER) {
  const serverRoot = path.join(homedir(), '.vscode-server', 'extensions');
  const serverExtDir = path.join(serverRoot, extFolderName);
  if (existsSync(localExtDir)) {
    mkdirSync(serverRoot, { recursive: true });
    rmSync(serverExtDir, { recursive: true, force: true });
    cpSync(localExtDir, serverExtDir, { recursive: true });
    log(`Mirrored → ${serverExtDir}`);
    upsertExtensionsJson(
      path.join(serverRoot, 'extensions.json'),
      serverExtDir,
    );
  } else {
    log(`Skip server mirror — no local install at ${localExtDir}`);
  }
} else {
  log('SKIP_SERVER set — not mirroring to ~/.vscode-server');
}

// Verify what was actually placed, rather than reporting on intent. A
// silent mismatch here is the whole failure mode: the script said
// "Installed" for weeks while mirroring a build from a fortnight earlier.
const placed = path.join(localExtDir, 'dist', 'extension.js');
const built = path.join(root, 'dist', 'extension.js');
if (existsSync(placed) && existsSync(built)) {
  const same = statSync(placed).size === statSync(built).size;
  if (!same) {
    log(
      `WARNING: installed bundle differs from the one just built (${statSync(placed).size} vs ${statSync(built).size} bytes) — something served a stale copy`,
    );
  }
}

log(
  cliInstalled
    ? `Installed ${extId}@${pkg.version} (via editor CLI)`
    : `Installed ${extId}@${pkg.version} (unpacked; the editor CLI declined)`,
);
log('Reload the VS Code window (or reconnect Remote-SSH) to activate.');
log('F5 Extension Development Host still overrides this only in the EDH window.');

/**
 * Ensure extensions.json lists this extension (VS Code may not rescan folders alone).
 */
function upsertExtensionsJson(jsonPath, extensionDir) {
  let list = [];
  if (existsSync(jsonPath)) {
    try {
      list = JSON.parse(readFileSync(jsonPath, 'utf8'));
      if (!Array.isArray(list)) {
        list = [];
      }
    } catch {
      list = [];
    }
  }
  const abs = path.resolve(extensionDir);
  list = list.filter((e) => e?.identifier?.id !== extId);
  list.push({
    identifier: { id: extId },
    version: pkg.version,
    location: {
      $mid: 1,
      path: abs,
      scheme: 'file',
    },
    relativeLocation: path.basename(extensionDir),
    metadata: {
      installedTimestamp: Date.now(),
      pinned: true,
      source: 'vsix',
    },
  });
  writeFileSync(jsonPath, `${JSON.stringify(list)}\n`, 'utf8');
  log(`Updated ${jsonPath}`);
}
