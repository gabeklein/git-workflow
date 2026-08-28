#!/usr/bin/env node
/**
 * Install the agent skill that ships with this extension.
 *
 * The extension's rules are not discoverable from the code an agent is
 * looking at: a derived branch it must not commit to, lane files it must
 * not hand-edit, and a headless opt-in it would never guess. So they ship
 * as a skill rather than as prose in a README nobody loads.
 *
 * User scope by default (~/.claude/skills) — the extension is installed
 * per machine, and every repo it manages wants the same rules. Pass
 * --project to put it in a single repo's .claude/skills instead.
 *
 * Usage: npm run install:skill [-- --project [dir]]
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'git-workflow';
const src = path.join(root, 'skills', NAME);

const args = process.argv.slice(2);
const at = args.indexOf('--project');
const dest =
  at === -1
    ? path.join(homedir(), '.claude', 'skills', NAME)
    : path.join(path.resolve(args[at + 1] ?? process.cwd()), '.claude', 'skills', NAME);

mkdirSync(path.dirname(dest), { recursive: true });
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[install:skill] Installed ${NAME} skill → ${dest}`);
