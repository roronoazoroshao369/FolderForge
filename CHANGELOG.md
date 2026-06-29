# Changelog

All notable changes to FolderForge are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and the project follows
semantic versioning.

## [Unreleased]

### Added

- **`--policy <mode>` CLI flag** (alias `--policy-mode`) to set the policy mode at
  startup: `readonly` | `safe` | `dev` | `danger`. The CLI value wins over the
  config file's `policy.defaultMode`. Invalid values are ignored with a warning
  and the configured mode is kept. Documented in the README CLI table.

## [1.4.2] - 2026-06-28

### Changed

- Pin the Playwright child-MCP adapter to a specific version (`@playwright/mcp@0.0.41`)
  instead of a floating tag, for reproducible browser-automation installs.

## [1.4.1] - 2026-06-28

### Changed

- Config-file handling now writes the auto-generated `config.yaml` on first run
  (refinement of the 1.4.0 zero-config behavior).

## [1.4.0] - 2026-06-28

### Added

- **Zero-config first run.** When no config is found in any discovery location,
  FolderForge writes a complete, batteries-included `folderforge.yaml` next to
  the project and loads it immediately (`policy.defaultMode: dev`,
  `tools.preset: vibe-lite`, and `adapters.playwright.enabled: true` so the
  `browser_*` tools work out of the box). Existing config files are never
  overwritten; `--config <file>` skips auto-generation; a failed write is
  non-fatal and falls back to built-in defaults.

## [1.3.3] - 2026-06-27

### Added

- **Interactive approval via MCP elicitation** with dashboard fallback. High-risk
  tool calls (e.g. `git_commit`, `file_delete`) prompt for approval directly in
  the chat when the client advertises the `elicitation` capability, falling back
  to the dashboard flow otherwise.
- **`ToolContentBlock` content blocks** (`text | resource | resource_link`) on
  `ToolResult`, with `git_diff` attaching the raw diff as an embedded
  `text/x-diff` resource.

---

For the full pre-1.3.3 history (1.0 hardening, 1.2 MCP protocol features and agent
ergonomics, and the 0.1-0.3 foundations), see `docs/roadmap.md`.
