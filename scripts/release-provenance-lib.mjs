import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as tar from 'tar';

export const RELEASE_BUNDLE_SCHEMA_VERSION = 1;
export const RELEASE_INVENTORY_SCHEMA_VERSION = 1;

export function digestFile(path, algorithm, encoding = 'hex') {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

export function describeFile(path) {
  const bytes = readFileSync(path).byteLength;
  return {
    name: basename(path),
    bytes,
    sha1: digestFile(path, 'sha1'),
    sha256: digestFile(path, 'sha256'),
    sha512: digestFile(path, 'sha512', 'base64'),
  };
}

export async function readPackedPackageJson(tarballPath) {
  const chunks = [];
  let found = false;
  await tar.t({
    file: tarballPath,
    strict: true,
    onentry(entry) {
      if (entry.path !== 'package/package.json') {
        entry.resume();
        return;
      }
      found = true;
      entry.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    },
  });
  if (!found) throw new Error('Tarball is missing package/package.json');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function parseRemoteTags(raw) {
  const direct = new Map();
  const peeled = new Map();
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [commit, ref] = line.split(/\s+/);
    if (!commit || !ref?.startsWith('refs/tags/')) continue;
    const name = ref.slice('refs/tags/'.length);
    if (name.endsWith('^{}')) peeled.set(name.slice(0, -3), commit);
    else direct.set(name, commit);
  }
  return new Map(
    [...direct].map(([tag, object]) => [
      tag,
      { object, commit: peeled.get(tag) ?? object, annotated: peeled.has(tag) },
    ]),
  );
}

export function classifyPublishedVersion({
  version,
  gitHead,
  sourceVersion,
  remoteTag,
  githubRelease,
}) {
  const expectedTag = `v${version}`;
  if (!gitHead) {
    return {
      status: 'unknown',
      reason: 'npm registry metadata does not declare gitHead',
    };
  }
  if (!sourceVersion) {
    return {
      status: 'registry-claim-only',
      reason: 'gitHead is declared by npm but the commit is unavailable locally',
    };
  }
  if (sourceVersion !== version) {
    return {
      status: 'registry-claim-conflict',
      reason: `npm gitHead contains package version ${sourceVersion}, not ${version}`,
    };
  }
  if (remoteTag && remoteTag.commit !== gitHead) {
    return {
      status: 'public-tag-conflict',
      reason: `${expectedTag} resolves to ${remoteTag.commit}, not npm gitHead ${gitHead}`,
    };
  }
  if (githubRelease && githubRelease.commit && githubRelease.commit !== gitHead) {
    return {
      status: 'github-release-conflict',
      reason: `GitHub Release resolves to ${githubRelease.commit}, not npm gitHead ${gitHead}`,
    };
  }
  if (remoteTag && githubRelease) {
    return {
      status: 'tag-and-release-aligned',
      reason: 'npm gitHead, source version, remote tag, and GitHub Release align',
    };
  }
  if (remoteTag) {
    return {
      status: 'tag-aligned-no-release',
      reason: 'npm gitHead, source version, and remote tag align; no GitHub Release exists',
    };
  }
  return {
    status: 'registry-commit-aligned',
    reason: 'npm gitHead exists locally and source version matches; no public tag proves it',
  };
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha512Integrity(base64Digest) {
  return `sha512-${base64Digest}`;
}
