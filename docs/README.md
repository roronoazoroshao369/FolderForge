# FolderForge documentation

This index separates current user and operator guidance from contributor design
material and historical records.

## Getting started

| Document | Audience | Purpose |
| --- | --- | --- |
| [README](../README.md) | User | Install, first run, MCP client examples, and product overview. |
| [Compatibility](compatibility.md) | User / Operator | Supported Node and operating-system matrix and evidence rules. |
| [Playwright setup](playwright-macos.md) | User / Operator | Browser installation, degraded behavior, diagnostics, and macOS notes. |
| [Godot MCP](godot-mcp.md) | User / Operator | Install the shipped Godot addon and use editor/runtime tools. |

## Guides

| Document | Audience | Purpose |
| --- | --- | --- |
| [ChatGPT connection](chatgpt-connect.md) | Operator | Guided Auth0/DCR lifecycle for ChatGPT connectors. |
| [OAuth](oauth.md) | Operator | External authorization-server and protected-resource configuration. |
| [Workflows](workflows.md) | User / Contributor | Persistent governed workflow usage. |
| [AI coding runtime](ai-coding-runtime.md) | User / Contributor | Analyze, patch, verify, and report workflow. |

## Reference

| Document | Audience | Purpose |
| --- | --- | --- |
| [Tools](tools.md) | User / Contributor | Native tool groups and behavior. |
| [Adapters](adapters.md) | User / Contributor | Child MCP configuration, facades, lifecycle, and diagnostics. |
| [Plugin system](plugin-system.md) | User / Contributor | Local plugin packaging and trust boundaries. |
| [MCP facade](mcp-facade.md) | Contributor | Large child-server facade contract. |

## Security

| Document | Audience | Purpose |
| --- | --- | --- |
| [Vulnerability reporting](../SECURITY.md) | User / Researcher | How to report a suspected vulnerability privately. |
| [Technical security model](security.md) | Operator / Contributor | Path, command, secret, approval, auth, and audit controls. |
| [OAuth ADR](adr-0004-oauth-resource-server.md) | Contributor / Maintainer | Resource-server architecture and trade-offs. |

## Architecture

| Document | Audience | Purpose |
| --- | --- | --- |
| [Architecture](architecture.md) | Contributor | Main components and data flow. |
| [MCP plugin architecture](mcp-plugin-architecture.md) | Contributor | Plugin architecture. |
| [Browser agent design](browser-agent-design.md) | Internal design | Browser design notes; not a current user contract. |

## Migration

| Document | Audience | Purpose |
| --- | --- | --- |
| [Migration to 2.0](migration-2.0.md) | User / Operator | Breaking and operational changes in 2.0. |
| [ChatGPT lifecycle v2](migration-chatgpt-lifecycle-v2.md) | Operator | Receipt and lifecycle migration notes. |

## Contributing and releasing

| Document | Audience | Purpose |
| --- | --- | --- |
| [Contributing](../CONTRIBUTING.md) | Contributor | Development, tests, pull requests, and review expectations. |
| [Release process](releasing.md) | Maintainer | Release gates and operator-controlled publication steps. |

## Internal / historical

These documents are useful context but are **not current product contracts**:

- [Roadmap](roadmap.md) — historical delivery record and future ideas.
- [AI-agent roadmap](ai-agent-roadmap.md) — planning material.
- [Implementation log](implementation-log.md) — historical implementation notes.
- [ChatGPT lifecycle plan](chatgpt-lifecycle-plan.md) — internal design plan.

When an internal document conflicts with README, reference, security, or
compatibility documentation, the current user-facing document and executable
tests take precedence.
