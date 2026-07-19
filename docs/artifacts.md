# Artifact store and browser quality tools

FolderForge stores large or reusable evidence under the active project's
`.folderforge/artifacts/` directory instead of requiring every client to retain
inline base64 forever. Objects are content-addressed with full SHA-256 IDs and
metadata is written atomically.

## Bounds and integrity

Default limits are 20 MiB per artifact, 500 MiB total, and 1,000 objects. Stored
objects are mode `0600` on POSIX, the store directory is mode `0700`, and a local
`.gitignore` prevents accidental commits. `artifact_get` recomputes SHA-256 and
checks the byte count before returning content. A modified object fails closed.

The public tools are:

- `artifact_put`, `artifact_list`, `artifact_get`, and `artifact_delete`;
- `artifact_compare` for deterministic PNG pixel comparison;
- `browser_screenshot`, which now preserves the MCP image block and also returns
  content-addressed artifact metadata;
- `browser_visual_compare`, which captures a PNG, compares it to a baseline, and
  can store a red diff artifact;
- `browser_accessibility_audit`, which runs a fixed read-only DOM audit.

Visual comparison reports dimensions, total pixels, changed pixels, percentage,
mean channel delta, and threshold. Different image dimensions are reported as
not comparable instead of resizing silently.

## Accessibility scope

The built-in audit checks document language/title, image alternatives, form and
interactive accessible names, duplicate IDs, heading-rank jumps, and a bounded
WCAG AA foreground/background contrast approximation. It examines at most 500
visible direct text nodes for contrast. The script is fixed by FolderForge; the
caller cannot inject JavaScript through this tool.

This is a fast regression gate, not a complete accessibility certification. It
does not replace assistive-technology testing, keyboard review, semantic UX
judgment, or a full standards engine such as axe-core. Public reports must state
this limitation.

## Workflow

```text
browser_open
  -> browser_set_viewport
  -> browser_accessibility_audit
  -> browser_screenshot (save baseline artifact ID)
  -> implement change
  -> browser_visual_compare (baselineId)
  -> artifact_get / artifact_list for evidence
```

Artifacts currently belong to the default project selected when the runtime
starts. Start a separate FolderForge instance per project when durable artifact
isolation is required across simultaneously active projects.
