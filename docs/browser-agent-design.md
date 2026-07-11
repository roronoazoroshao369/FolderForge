# Browser Agent Design

The browser integration is the UI execution and inspection layer for AI coding
agents. FolderForge provides a stable `browser_*` contract and delegates browser
control to the pinned Playwright MCP child server.

## Supported workflow

```text
implement FE
  -> start dev/preview server
  -> browser_open
  -> browser_set_viewport
  -> browser_snapshot
  -> browser_click / browser_type
  -> browser_console / browser_network
  -> browser_screenshot
  -> AI vision review
  -> fix and repeat
```

## Public browser tools

| Tool | Purpose | Risk |
| --- | --- | --- |
| `browser_open` | Navigate to a URL | MEDIUM |
| `browser_snapshot` | Read the accessibility/semantic snapshot | LOW |
| `browser_click` | Click an element using a snapshot ref | MEDIUM |
| `browser_type` | Fill an input and optionally submit | MEDIUM |
| `browser_console` | Read console messages | LOW |
| `browser_network` | Read network requests | LOW |
| `browser_screenshot` | Capture viewport, full page, or an element | MEDIUM |
| `browser_set_viewport` | Resize for responsive testing | MEDIUM |
| `browser_close` | Close the browser session | MEDIUM |
| `browser_eval` | Evaluate JavaScript in the page | HIGH |

`browser_screenshot` accepts Playwright's image format, optional filename,
element/ref target, and `fullPage` flag. The resulting image is returned as a
standard top-level MCP `image` content block.

## Rich image path

```text
Playwright child
  content: [{type:text}, {type:image,data,mimeType}]
       |
       v
normalizeChildContent
  ToolResult.content: [{kind:text}, {kind:image,data,mimeType}]
       |
       v
toCallToolResult
  content: [{type:text}, {type:text}, {type:image,data,mimeType}]
```

The raw child result remains in `ToolResult.data`, but `data.content` is removed
from the compatibility text summary once promoted. This avoids sending the same
base64 image twice.

## Error and audit semantics

A child result with `isError: true` is not a successful proxy call. FolderForge
converts it to `ToolResult.ok: false`, returns MCP `isError: true`, and records a
`tool_error` audit event. The child diagnostic text is preserved.

## Responsive testing

`browser_set_viewport` maps to Playwright `browser_resize` and requires integer
`width` and `height` values from 1 to 10,000 CSS pixels. Agents should test at
least one mobile and one desktop viewport for user-facing pages.

## Session isolation

Generated/default Playwright adapter arguments include `--isolated`. This avoids
profile-lock collisions when multiple FolderForge instances run at once and
prevents cookies/local state from leaking between independent AI sessions.
Persistent browser state is opt-in by overriding adapter arguments and assigning
a dedicated `--user-data-dir`.

## Live acceptance test

The Milestone 1.7 live test used `dist/main.js` over HTTP and a local FE fixture.
It verified:

- source-built server reports version `1.6.0`;
- full preset advertises 249 native tools and all 10 browser wrappers;
- mobile viewport is exactly 390×844;
- snapshot refs, click interaction, console, and network work;
- screenshot is a valid top-level `image/png` block;
- decoded PNG dimensions are 390×844;
- screenshot base64 is not duplicated in the text summary;
- invalid navigation returns MCP `isError: true`;
- audit records the failed child call as `tool_error`, `ok:false`;
- browser close succeeds.

## Current limitations

- FolderForge transports the image correctly, but a client may need to reconnect
  or refresh its MCP tool namespace after upgrading the server.
- Automated visual-diff, accessibility scanning, and UX scoring are not yet
  native tools. Agents can already review screenshots and semantic snapshots,
  but baseline comparison and rule-based audits remain roadmap work.
- Large screenshots are inline base64. A future artifact/resource store should be
  used for very large or long-lived assets.

## Next browser slices

1. Add deterministic screenshot artifact IDs and optional resource retrieval.
2. Add visual baseline comparison with diff metadata.
3. Add an accessibility scanner and contrast checks.
4. Add browser context/device presets and network throttling.
5. Add a composed browser test-flow tool only after primitives remain the source
   of truth and every step stays auditable.
