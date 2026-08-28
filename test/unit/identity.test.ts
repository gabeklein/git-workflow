import { describe, expect, it } from 'vitest';
import {
  baseName,
  stateFile,
  type Preview,
} from '../../src/git/preview/identity';

/**
 * The identity a second preview will need. The interesting property is
 * the default one keeping the FLAT state-file names — those are a protocol
 * shared with agent-focus's focus-working.sh, and prefixing them would
 * break that interop silently.
 */
describe('preview identity', () => {
  const preview: Preview = {
    branch: 'preview/main',
    baseRef: 'origin/main',
  };

  it('strips the remote from the base name', () => {
    expect(baseName(preview)).toBe('main');
    expect(baseName({ ...preview, baseRef: 'main' })).toBe('main');
    expect(baseName({ ...preview, baseRef: 'origin/release/2.x' })).toBe(
      'release/2.x',
    );
  });

  it('leaves the default preview on the flat protocol names', () => {
    // focus-working.sh reads these exact paths
    expect(stateFile(preview, 'focus-applied')).toBe('focus-applied');
    expect(stateFile(preview, 'focus-working.lock')).toBe('focus-working.lock');
  });

  it('keys additional previews without touching the first', () => {
    const staging: Preview = {
      branch: 'preview/staging',
      baseRef: 'origin/staging',
      stateKey: 'focus-staging',
    };
    expect(stateFile(staging, 'focus-applied')).toBe(
      'focus-staging/focus-applied',
    );
    // ...and the default is still where the script expects it
    expect(stateFile(preview, 'focus-applied')).toBe('focus-applied');
  });
});
