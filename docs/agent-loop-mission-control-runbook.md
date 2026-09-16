# Agent Loop and Mission Control runbook

## Public OpenAI-compatible endpoint

Use the public HTTPS base URL with `/v1`, not `/mcp`. The gateway exposes `/v1/models` and `/v1/responses` for Codex-compatible clients. The current model id is `folderforge-agent`.

## Safe execution contract

Requests are routed through the durable Agent Loop: discovery, weighted expert council, governed implementation workflow, and verification. A request without a validated `implementationWorkflowId` fails closed with `agent_loop_blocked`; it must never claim a repository change without changed-path evidence.

## Mission Control checks

Use the dashboard to inspect gateway state at `/responses/status`, configure the selected implementation workflow at `/responses/config`, and monitor Agent Loop progress. Keep `/mcp` reserved for MCP clients and use `/v1` for OpenAI-compatible clients.

## Remote Codex connection

Configure the remote Codex client with the public HTTPS `/v1` base URL, model `folderforge-agent`, and the issued bearer credential. Treat quick-tunnel URLs as ephemeral and rotate credentials if exposure is suspected.
