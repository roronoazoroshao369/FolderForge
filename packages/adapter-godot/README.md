# @folderforge/adapter-godot

Godot integration primitives extracted from FolderForge's governance runtime.

The package contains two implementation channels:

- `GodotCli`: headless engine probes and project-file operations.
- `GodotRuntime`: a short-lived TCP client for the optional in-game runtime bridge.

It does not register MCP tools, evaluate FolderForge policy, or grant filesystem
access. A host application must supply its own governance and path boundary.

```ts
import { GodotCli, GodotRuntime } from '@folderforge/adapter-godot';

const config = {
  enabled: true,
  godotPath: 'godot',
  editorPort: 6550,
  runtimePort: 9090,
};

const cli = new GodotCli(config);
const runtime = new GodotRuntime(config);
```

This package is currently a local extraction candidate. Publishing it requires a
separate versioning, compatibility, and release decision; the root FolderForge
package temporarily consumes its built artifact through an internal import map.
