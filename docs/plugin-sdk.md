# Plugin SDK CLI

FolderForge ships a dependency-free plugin development workflow through the main
CLI. It creates MCP templates, validates package boundaries, performs a real child
MCP handshake, produces deterministic archives, and prepares signed marketplace
artifacts without running package-manager lifecycle scripts or uploading anything.

## Commands

```bash
folderforge plugin init ./my-plugin --id my-plugin
folderforge plugin validate ./my-plugin
folderforge plugin test ./my-plugin
folderforge plugin pack ./my-plugin --out ./dist/my-plugin-1.0.0.tgz
folderforge plugin keygen ./publisher-keys
folderforge plugin sign ./my-plugin \
  --publisher-id my-team \
  --private-key ./publisher-keys/publisher-private.pem \
  --repository https://example.invalid/my-plugin \
  --commit <exact-commit-sha> \
  --workflow .github/workflows/plugin.yml \
  --out ./dist/my-plugin-1.0.0.tgz
```

All commands support `--json` for machine-readable output.

## `plugin init`

The generated template contains:

- `folderforge.plugin.json` with explicit permissions and per-tool risk;
- a dependency-free line-delimited JSON-RPC MCP server;
- `health` and bounded `echo` tools;
- no install, postinstall, prepare, or publish lifecycle script;
- a private package manifest and starter README.

Process mode is the default development runtime. A Docker/Podman template can be
requested with `--sandbox docker|podman --image image@sha256:<digest>`. Container
templates require digest pinning at creation time.

The command refuses a non-empty target unless `--force` is explicit. Force mode
only replaces generated filenames; it does not delete unrelated files.

## `plugin validate`

Validation reuses the production plugin manifest parser and package-integrity
algorithm. It verifies:

- FolderForge compatibility;
- runtime, permission, risk, and sandbox schema;
- relative runtime-command confinement;
- absence of symlinks and non-regular files;
- at most 2,000 files and 50 MiB extracted content;
- deterministic SHA-256 package-tree integrity.

Package lifecycle scripts are reported as warnings because FolderForge never
executes them during local install/test. Marketplace signing remains stricter and
rejects lifecycle scripts.

## `plugin test`

Testing copies the plugin into a disposable FolderForge plugin root, derives the
same adapter definition used by production, applies Docker/Podman sandbox wrapping
when declared, and uses the bounded child-MCP client to perform:

1. process/container start;
2. MCP initialize and protocol negotiation;
3. complete paginated `tools/list`;
4. bounded cleanup with process-tree termination.

No plugin tool is called by default. An explicit development call is available:

```bash
folderforge plugin test ./my-plugin \
  --call health \
  --args-json '{}'
```

The timeout is bounded to 1–60 seconds. A failed start returns the production child
MCP diagnostic rather than falling back to another runtime.

## `plugin pack`

Packing creates a gzip tar archive with:

- sorted, bounded regular files only;
- no `.git` directory;
- portable normalized metadata;
- no mtime;
- output required to be outside the source tree;
- SHA-256 evidence in the command result.

Two packs of the same source produce identical bytes. The command does not install
dependencies, execute scripts, sign, or publish.

## `plugin keygen`

Key generation creates an Ed25519 pair. On POSIX systems:

- private key mode is `0600`;
- public key mode is `0644`.

Existing files are not overwritten without `--force`, and private/public paths
must differ. Private keys should remain outside plugin source and version control.

## `plugin sign`

Signing stages a clean copy and generates deterministic:

- CycloneDX 1.6 SBOM metadata;
- provenance bound to repository, exact commit, workflow, builder, and source-tree
  SHA-256;
- prepared-package tgz;
- signed immutable marketplace entry.

Before signing, the marketplace scanner rejects symlinks, nested archives,
lifecycle scripts, known credential patterns, invalid manifests, missing/invalid
SBOM or provenance, and package-budget violations. The private key is never copied
into the package or entry.

The output package and entry are local preparation artifacts. `plugin sign` does
not register a public publisher, modify a remote index, upload a package, open a
marketplace listing, or revoke an existing publisher. Those are explicit operator
and public-infrastructure actions.
