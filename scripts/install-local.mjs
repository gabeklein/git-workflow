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
const vsixPath = path.join(root, vsixName);

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

function which(bin) {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

// 1) Production build
run('npm run package');

// 2) VSIX (vsce runs vscode:prepublish again — fine)
run(
  'npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license',
);

if (!existsSync(vsixPath)) {
  console.error(`[install:local] expected VSIX missing: ${vsixPath}`);
  process.exit(1);
}
log(`VSIX: ${vsixPath}`);

// 3) Install via Code CLI when available
const codeBin = which('code');
if (!process.env.SKIP_CODE_CLI && codeBin) {
  run(`"${codeBin}" --install-extension "${vsixPath}" --force`);
} else if (!codeBin) {
  log('code CLI not found — skipping CLI install (will still mirror folders)');
} else {
  log('SKIP_CODE_CLI set — skipping code --install-extension');
}

// Source tree after CLI install (preferred) or unpack from VSIX zip
const localExtRoot = path.join(homedir(), '.vscode', 'extensions');
const localExtDir = path.join(localExtRoot, extFolderName);

if (!existsSync(path.join(localExtDir, 'package.json'))) {
  log(`CLI did not create ${localExtDir}; unpacking VSIX there`);
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

log(`Installed ${extId}@${pkg.version}`);
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
