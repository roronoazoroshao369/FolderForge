import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  validateReleaseMetadata,
} from '../../scripts/release-preflight-lib.mjs';

function fixture({
  version = '2.7.2',
  lockVersion = version,
  rootVersion = version,
  tarRange = '^7.5.22',
  lockedTar = '7.5.22',
} = {}) {
  return {
    packageJson: {
      version,
      dependencies: { tar: tarRange },
    },
    packageLock: {
      version: lockVersion,
      packages: {
        '': { version: rootVersion },
        'node_modules/tar': { version: lockedTar },
      },
    },
  };
}

describe('release preflight metadata', () => {
  it('compares numeric semantic versions', () => {
    expect(compareVersions('7.5.22', '7.5.22')).toBe(0);
    expect(compareVersions('7.5.23', '7.5.22')).toBe(1);
    expect(compareVersions('7.5.20', '7.5.22')).toBe(-1);
  });

  it('accepts synchronized metadata with a patched tar dependency', () => {
    const { packageJson, packageLock } = fixture();
    expect(validateReleaseMetadata(packageJson, packageLock)).toMatchObject({
      version: '2.7.2',
      errors: [],
      safeTarVersion: '7.5.22',
    });
  });

  it('rejects stale package-lock version metadata', () => {
    const { packageJson, packageLock } = fixture({ lockVersion: '2.7.1' });
    expect(validateReleaseMetadata(packageJson, packageLock).errors).toEqual([
      expect.stringContaining('does not match package.json'),
    ]);
  });

  it('rejects dependency ranges and locks that can select vulnerable tar', () => {
    const { packageJson, packageLock } = fixture({
      tarRange: '^7.5.20',
      lockedTar: '7.5.20',
    });
    expect(validateReleaseMetadata(packageJson, packageLock).errors).toEqual([
      expect.stringContaining('package.json must require tar >=7.5.22'),
      expect.stringContaining('package-lock.json must resolve tar >=7.5.22'),
    ]);
  });
});
