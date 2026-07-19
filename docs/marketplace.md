# Verified plugin marketplace

FolderForge 2.5 provides a local verified marketplace/index runtime. It separates
publisher trust, immutable signed metadata, package quarantine, moderation, and
plugin enablement. Importing an index never executes a package.

## Trust objects

A marketplace entry binds:

- plugin ID, version, name, and description;
- Ed25519 publisher identity and signature;
- exact package SHA-256;
- manifest, CycloneDX SBOM, and provenance SHA-256 values;
- source repository, commit, workflow, and source digest;
- FolderForge/MCP compatibility;
- declared network/filesystem/environment permissions;
- publication timestamp.

Versions are immutable. Importing a second entry with the same `id@version` but
different bytes fails. Publisher revocation immediately makes its entries
uninstallable without rewriting the signed index.

## Publisher administration

Use the admin-only tools:

- `marketplace_publisher_add`;
- `marketplace_publisher_list`;
- `marketplace_publisher_revoke`.

Only Ed25519 keys are accepted. The private key is never stored by the
marketplace manager. `marketplace_package` reads an explicitly supplied local
private-key path only for the signing operation and is admin-only/high-risk.

## Prepare a package

A prepared package directory must include:

```text
folderforge.plugin.json
sbom.cdx.json
provenance.json
...plugin runtime files...
```

Before signing, `marketplace_scan` validates compatibility and rejects:

- lifecycle scripts such as `preinstall`, `install`, `postinstall`, or `prepare`;
- symlinks and non-regular filesystem entries;
- nested archives;
- file-count or expanded-byte budget violations;
- detected credentials/secrets;
- missing or invalid manifest, SBOM, or provenance JSON.

The scanner reports executable files as review evidence. Execution remains
subject to plugin policy and the declared Docker/Podman sandbox.

`marketplace_package` creates a deterministic gzip tarball, verifies the private
key matches the registered publisher, scans the source, and signs an immutable
entry. It does not upload the package or publish an index.

## Sync and inspect

`marketplace_sync` accepts a bounded HTTPS URL, `file://` URL, or local path. An
optional expected index SHA-256 can pin the entire index transfer. Each entry is
verified against the local publisher trust store before import.

Use:

- `marketplace_list` for search and trust state;
- `marketplace_inspect` for signature, provenance, moderation, and quarantine
  evidence;
- `marketplace_export` to write the reviewed local index for separate hosting.

HTTP, redirects, unknown publishers, revoked publishers, invalid signatures, and
immutable version conflicts fail closed.

## Quarantine and install

`marketplace_quarantine`:

1. downloads/reads the exact signed package URL with size limits;
2. verifies the package SHA-256;
3. extracts with traversal, absolute-path, symlink, hardlink, device, FIFO,
   file-count, and expanded-byte protections;
4. reruns the complete package scanner;
5. verifies manifest/SBOM/provenance digests and provenance content against the
   signed entry;
6. records the result under `.folderforge/marketplace/quarantine/`.

Only a listed entry from an active publisher with a passing quarantine record can
reach `marketplace_install`. Installation always starts **disabled**. Separate
inspection and the governed `plugin_enable` action remain required before code
runs.

## Moderation

`marketplace_moderate` overlays one local decision without altering publisher
signatures:

- `listed`;
- `yanked`;
- `security-hold`.

Yanked or held versions cannot be quarantined or installed. This supports local
incident response while preserving immutable evidence.

## What is not automatic

FolderForge does not automatically:

- grant a verified publisher identity;
- host package files or the index;
- approve a plugin submission;
- enable installed plugins;
- claim malware-free code from static scanning alone;
- replace private vulnerability reporting, takedown, or legal review.

Opening a public hosted marketplace remains an operator-controlled action and
requires real moderation, identity verification, availability, and incident
response outside the repository.
