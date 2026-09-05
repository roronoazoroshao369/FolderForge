# content-mcp — folder-first content studio MCP

An MCP server that lets an AI agent (Claude, ChatGPT, Cursor, …) manage draft
posts living in a plain folder and publish approved content to **Facebook
Pages** and **YouTube** — no custom app required. Pair it with FolderForge to
get approvals, policy, and audit for free.

## Why an MCP and not an app

The consumer is an AI agent; MCP is the protocol agents speak natively. The
human side (review/approve/audit) is already covered by FolderForge Mission
Control when this server runs as a governed child/instance — so no separate
management UI is needed until you want rich workflows (content calendar,
drag-drop media, multi-round review).

## Layout

Drafts are markdown files with a small frontmatter block in `CONTENT_DIR`
(default `./content`):

```markdown
---
title: My launch post
targets: [facebook, youtube]
status: draft
---

Body text / caption / video description.
```

`status: draft -> approved -> published`. Publish tools refuse anything not
`approved`, so a human (or a FolderForge approval gate) always has the last
word before anything goes public.

## Tools

| Tool | Mutates | Purpose |
|---|---|---|
| `list_drafts` / `read_draft` | no | browse the folder |
| `create_draft` / `update_draft` | folder only | author + approve |
| `delete_draft` | folder only | delete never-published drafts |
| `publish_facebook` | **public** | post to a Facebook Page (`/feed`) |
| `publish_youtube` | **public** | resumable video upload (private/unlisted/public) |

## Setup

```bash
cd examples/content-mcp
npm install
npm run build
```

### Facebook (Meta Graph API)

1. Create an app at <https://developers.facebook.com/apps> (type: Business).
2. Add a Page you manage; create a Page Access Token with `pages_manage_posts`
   (+ `pages_read_engagement`).
3. Export:

```bash
export FB_PAGE_ID="1234567890"
export FB_PAGE_ACCESS_TOKEN="EAAG..."
```

Development mode works for Pages you own; production posting requires Meta
App Review.

### YouTube (Data API v3)

1. Google Cloud console → create a project, enable **YouTube Data API v3**.
2. Create OAuth credentials (Web), note client id/secret.
3. Get a refresh token (scope `https://www.googleapis.com/auth/youtube.upload`),
   e.g. via the OAuth playground.
4. Export:

```bash
export YT_CLIENT_ID="...apps.googleusercontent.com"
export YT_CLIENT_SECRET="..."
export YT_REFRESH_TOKEN="..."
```

Unverified apps upload as **private** until Google verification — that is the
safe default here too.

## Run

```bash
CONTENT_DIR=/path/to/content node dist/index.js   # stdio MCP
```

Register it in any MCP client as a stdio server.

## Governed operation with FolderForge (recommended)

Run it as a child/instance under FolderForge so every call goes through the
policy/approval/audit pipeline:

```yaml
# folderforge.yaml (excerpt)
adapters:
  content:
    command: node
    args: [/path/to/examples/content-mcp/dist/index.js]
    env: { CONTENT_DIR: /path/to/content }
policy:
  defaultMode: safe
```

Then mark the publish tools as approval-gated (HIGH/CRITICAL) in your policy,
and approvals surface in Mission Control → Approvals with a full audit trail
in Mission Control → Audit.
