const SAFE_TAR_VERSION = '7.5.22';

export function compareVersions(left, right) {
  const leftParts = String(left).split('.').map((value) => Number.parseInt(value, 10));
  const rightParts = String(right).split('.').map((value) => Number.parseInt(value, 10));
  if (
    leftParts.length !== 3 ||
    rightParts.length !== 3 ||
    [...leftParts, ...rightParts].some((value) => !Number.isInteger(value) || value < 0)
  ) {
    throw new Error(`Expected numeric semantic versions, received ${left} and ${right}.`);
  }
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

function minimumVersionFromRange(range) {
  const match = /^(?:\^|~|>=)?(\d+\.\d+\.\d+)$/.exec(String(range ?? '').trim());
  return match?.[1] ?? null;
}

export function validateReleaseMetadata(packageJson, packageLock) {
  const errors = [];
  const version = String(packageJson?.version ?? '');
  const lockVersion = String(packageLock?.version ?? '');
  const lockRootVersion = String(packageLock?.packages?.['']?.version ?? '');

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    errors.push(`package.json has an invalid release version: ${version || '<missing>'}`);
  }
  if (lockVersion !== version || lockRootVersion !== version) {
    errors.push(
      `package-lock.json version metadata (${lockVersion}, ${lockRootVersion}) does not match package.json ${version}.`,
    );
  }

  const tarRange = String(packageJson?.dependencies?.tar ?? '');
  const minimumTar = minimumVersionFromRange(tarRange);
  if (!minimumTar || compareVersions(minimumTar, SAFE_TAR_VERSION) < 0) {
    errors.push(
      `package.json must require tar >=${SAFE_TAR_VERSION}; received ${tarRange || '<missing>'}.`,
    );
  }

  const lockedTar = String(packageLock?.packages?.['node_modules/tar']?.version ?? '');
  try {
    if (!lockedTar || compareVersions(lockedTar, SAFE_TAR_VERSION) < 0) {
      errors.push(
        `package-lock.json must resolve tar >=${SAFE_TAR_VERSION}; received ${lockedTar || '<missing>'}.`,
      );
    }
  } catch {
    errors.push(`package-lock.json contains an invalid tar version: ${lockedTar || '<missing>'}.`);
  }

  return { version, errors, safeTarVersion: SAFE_TAR_VERSION };
}
