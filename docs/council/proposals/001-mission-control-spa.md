# Proposal 001: Mission Control SPA + install-time bootstrap

- Author role: DX/UI Designer (overriding Hội đồng #3 decision per user directive)
- Date: 2026-08-26
- Status: approved (user directive, 2026-08-26)
- ADR link: docs/adr-0012-mission-control-control-plane.md

## Problem

The extended vanilla dashboard is a capable admin plane but it is not the
product the user asked for: a brand-new, full UI/UX frontend that fully
manages and provisions MCP servers for every folder on the machine — and
after `npm i -g @musashishao/folderforge`, the machine should have the
control website immediately, not after hand-running a dev build.

## Proposal

1. `packages/mission-control`: React 18 + Vite + TypeScript SPA. Sidebar
   shell, dark design system, screens: Overview, Fleet (provision /
   start / stop / restart / auto-restart / token show-once), Tunnels,
   Workspaces, Plugins & Marketplace, Approvals, Audit, Settings (token).
   It consumes only the existing governed dashboard API (`/fleet`,
   `/tunnels`, `/plugins`, `/workspaces`, `/approvals`, …) — zero new backend
   surface.
2. Serve the built SPA at `/app` from the dashboard server when
   `dist/dashboard/app` exists; vanilla UI stays at `/` as legacy fallback.
3. Bootstrap: SPA assets are built at publish/CI time and shipped in the
   npm package; `npm run build` builds it when package deps are installed
   (skip otherwise). Follow-up: `folderforge control start|stop|status|open`
   background control-plane command.

## Threat surface (Security hat)

No new backend endpoints; the SPA inherits the dashboard's loopback/token
auth and `?token=` convention. Built assets are static, no secrets embedded
(token lives in browser localStorage only, per existing convention).

## Test plan (QA hat)

- `tsc --noEmit` + `vite build` in the package (type + bundling gate).
- Root `project_verify` typecheck/lint/build stays green.
- Serve check: `GET /app` returns the SPA shell when built.
- Full suite unchanged (no backend behavior change).

## Rollback

Delete `packages/mission-control` + revert the two wiring edits
(copy-static-assets, server static route). Vanilla dashboard untouched.

## Decision log

- 2026-08-26 — user directive — approve — overrides Hội đồng #3 (extend
  vanilla) — implement in increments, starting with scaffold + build wiring.
