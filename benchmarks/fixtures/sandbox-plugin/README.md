# Sandbox plugin benchmark fixture

Build the image locally, inspect its immutable repository digest, and copy the
template to `folderforge.plugin.json` with that exact digest:

```bash
docker build --pull=false -t folderforge/sandbox-benchmark:local .
docker image inspect folderforge/sandbox-benchmark:local
```

The benchmark harness must not pull an image. Set an undeclared host variable
`FOLDERFORGE_BENCHMARK_UNDECLARED_SECRET`, set the declared
`BENCHMARK_ALLOWED`, install the prepared directory, and call
`inspect_boundary`. A pass requires a workspace write, no undeclared secret,
`/plugin` as the working directory, no network, and the configured resource
limits visible in adapter diagnostics. Keep the generated
`folderforge.plugin.json` local; it contains a machine-specific image digest.
