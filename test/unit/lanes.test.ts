import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pruneDeadLanes,
  readLaneFile,
  writeLaneFile,
} from '../../src/git/integration/lanes';
import { addBranch, makeRepo, type ScratchRepo } from './helpers';

describe('lane files', () => {
  let scratch: ScratchRepo;
  beforeEach(() => {
    scratch = makeRepo();
  });
  afterEach(() => {
    scratch.cleanup();
  });

  const stateFile = (f: string) => path.join(scratch.repo, '.git', f);

  it('writeLaneFile dedupes, sorts, and round-trips through readLaneFile', async () => {
    await writeLaneFile(scratch.repo, 'focus-applied', [
      'feat/b',
      'feat/a',
      'feat/b',
      '',
    ]);
    expect(fs.readFileSync(stateFile('focus-applied'), 'utf8')).toBe(
      'feat/a\nfeat/b\n',
    );
    expect(await readLaneFile(scratch.repo, 'focus-applied')).toEqual([
      'feat/a',
      'feat/b',
    ]);
  });

  it('readLaneFile skips blanks and #comments; missing file reads empty', async () => {
    fs.writeFileSync(
      stateFile('focus-applied'),
      '# comment\n\n  feat/a  \n',
    );
    expect(await readLaneFile(scratch.repo, 'focus-applied')).toEqual([
      'feat/a',
    ]);
    expect(await readLaneFile(scratch.repo, 'focus-missing')).toEqual([]);
  });
});

describe('pruneDeadLanes', () => {
  let scratch: ScratchRepo;
  beforeEach(() => {
    scratch = makeRepo();
    addBranch(scratch.repo, 'feat/alive', 'alive.txt', 'alive\n');
  });
  afterEach(() => {
    scratch.cleanup();
  });

  const stateFile = (f: string) => path.join(scratch.repo, '.git', f);
  const seedGhosts = () => {
    fs.writeFileSync(stateFile('focus-applied'), 'feat/alive\nfeat/dead\n');
    fs.writeFileSync(
      stateFile('focus-candidates'),
      'feat/alive\nfeat/dead\nfeat/ghost\n',
    );
    fs.writeFileSync(stateFile('focus-wip'), 'feat/dead\n');
    fs.writeFileSync(stateFile('focus-excluded'), 'feat/ghost\n');
  };

  it('drops lanes whose branch no longer exists from every state file', async () => {
    seedGhosts();
    expect(await pruneDeadLanes(scratch.repo)).toEqual([
      'feat/dead',
      'feat/ghost',
    ]);
    expect(fs.readFileSync(stateFile('focus-applied'), 'utf8')).toBe(
      'feat/alive\n',
    );
    expect(fs.readFileSync(stateFile('focus-candidates'), 'utf8')).toBe(
      'feat/alive\n',
    );
    expect(fs.readFileSync(stateFile('focus-wip'), 'utf8')).toBe('');
    expect(fs.readFileSync(stateFile('focus-excluded'), 'utf8')).toBe('');
  });

  it('is a no-op while the rebuild lock is held (retries next refresh)', async () => {
    seedGhosts();
    const lock = stateFile('focus-working.lock');
    fs.mkdirSync(lock);
    try {
      expect(await pruneDeadLanes(scratch.repo)).toEqual([]);
      expect(fs.readFileSync(stateFile('focus-applied'), 'utf8')).toContain(
        'feat/dead',
      );
    } finally {
      fs.rmdirSync(lock);
    }
  });

  it('is idempotent and touches nothing when every lane is alive', async () => {
    seedGhosts();
    await pruneDeadLanes(scratch.repo);
    expect(await pruneDeadLanes(scratch.repo)).toEqual([]);
    expect(fs.existsSync(stateFile('focus-working.lock'))).toBe(false);
  });
});
